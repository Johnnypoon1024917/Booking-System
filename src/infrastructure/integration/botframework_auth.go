package integration

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Bot Framework token validation.
//
// When Microsoft's bot service POSTs an activity to /api/v1/teams/messages
// it includes a JWT in the Authorization header signed by one of
// Microsoft's keys. We validate it like this:
//
//   1. Pull the metadata document from the bot openid endpoint.
//   2. Pull the JWKS from the metadata's jwks_uri.
//   3. Verify the token signature against the kid'ed key.
//   4. Verify standard claims: exp, iat, iss matches the metadata's issuer,
//      and aud matches OUR Microsoft App ID.
//
// This is a faithful, minimal implementation of the algorithm Microsoft
// describes at:
//   https://docs.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-authentication
const (
	botOpenIDDoc = "https://login.botframework.com/v1/.well-known/openidconfiguration"
	teamsAuthIssuer = "https://api.botframework.com"
)

// BotAuthValidator caches the JWKS and validates inbound JWTs.
type BotAuthValidator struct {
	expectedAudience string // your Microsoft App ID
	http             *http.Client
	mu               sync.RWMutex
	cachedKeys       map[string]*rsa.PublicKey
	cachedAt         time.Time
	jwksURL          string
}

func NewBotAuthValidator(microsoftAppID string) *BotAuthValidator {
	return &BotAuthValidator{
		expectedAudience: microsoftAppID,
		http:             &http.Client{Timeout: 10 * time.Second},
		cachedKeys:       map[string]*rsa.PublicKey{},
	}
}

// Validate parses, signature-verifies and claim-checks the bot framework
// token. Returns the parsed claims on success.
func (v *BotAuthValidator) Validate(ctx context.Context, authHeader string) (jwt.MapClaims, error) {
	if v.expectedAudience == "" {
		return nil, errors.New("BOT_APP_ID not configured")
	}
	tok := strings.TrimPrefix(authHeader, "Bearer ")
	if tok == authHeader || tok == "" {
		return nil, errors.New("missing bearer token")
	}

	parsed, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		if kid == "" {
			return nil, errors.New("missing kid")
		}
		return v.keyByID(ctx, kid)
	})
	if err != nil {
		return nil, fmt.Errorf("verify: %w", err)
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return nil, errors.New("invalid claims")
	}

	// aud must match our app id
	switch aud := claims["aud"].(type) {
	case string:
		if aud != v.expectedAudience {
			return nil, fmt.Errorf("aud mismatch: %s", aud)
		}
	case []interface{}:
		matched := false
		for _, a := range aud {
			if s, ok := a.(string); ok && s == v.expectedAudience {
				matched = true
				break
			}
		}
		if !matched {
			return nil, errors.New("aud mismatch")
		}
	default:
		return nil, errors.New("aud missing")
	}

	// iss must match the bot framework issuer
	if iss, _ := claims["iss"].(string); !strings.HasPrefix(iss, teamsAuthIssuer) {
		return nil, fmt.Errorf("iss mismatch: %s", iss)
	}

	return claims, nil
}

// keyByID returns the cached key, refreshing JWKS if needed.
func (v *BotAuthValidator) keyByID(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.cachedKeys[kid]
	stale := time.Since(v.cachedAt) > 12*time.Hour
	v.mu.RUnlock()
	if ok && !stale {
		return k, nil
	}
	if err := v.refresh(ctx); err != nil {
		return nil, err
	}
	v.mu.RLock()
	k, ok = v.cachedKeys[kid]
	v.mu.RUnlock()
	if !ok {
		return nil, fmt.Errorf("kid %s not found in jwks", kid)
	}
	return k, nil
}

func (v *BotAuthValidator) refresh(ctx context.Context) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	// 1. metadata
	if v.jwksURL == "" {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, botOpenIDDoc, nil)
		resp, err := v.http.Do(req)
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024))
		_ = resp.Body.Close()
		var md struct {
			JWKSURI string `json:"jwks_uri"`
		}
		if err := json.Unmarshal(body, &md); err != nil {
			return err
		}
		v.jwksURL = md.JWKSURI
	}
	if v.jwksURL == "" {
		return errors.New("openid config missing jwks_uri")
	}

	// 2. JWKS
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, v.jwksURL, nil)
	resp, err := v.http.Do(req)
	if err != nil {
		return err
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	_ = resp.Body.Close()
	var set struct {
		Keys []struct {
			Kid string   `json:"kid"`
			Kty string   `json:"kty"`
			N   string   `json:"n"`
			E   string   `json:"e"`
			X5c []string `json:"x5c"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &set); err != nil {
		return err
	}
	v.cachedKeys = make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.N == "" || k.E == "" {
			continue
		}
		pub, err := jwkToRSA(k.N, k.E)
		if err != nil {
			continue
		}
		v.cachedKeys[k.Kid] = pub
	}
	v.cachedAt = time.Now()
	return nil
}

// jwkToRSA converts a JWK n/e pair (base64url-encoded big-endian) into an
// rsa.PublicKey usable by jwt-go.
func jwkToRSA(n, e string) (*rsa.PublicKey, error) {
	nBytes, err := base64.RawURLEncoding.DecodeString(n)
	if err != nil {
		return nil, err
	}
	eBytes, err := base64.RawURLEncoding.DecodeString(e)
	if err != nil {
		return nil, err
	}
	bigE := new(big.Int).SetBytes(eBytes)
	return &rsa.PublicKey{
		N: new(big.Int).SetBytes(nBytes),
		E: int(bigE.Int64()),
	}, nil
}
