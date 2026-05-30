package integration

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"fsd-mrbs/src/infrastructure/safehttp"

	"github.com/golang-jwt/jwt/v5"
)

// Microsoft Graph change-notifications include a `validationTokens` array
// in the request body. Each token is a JWT signed by Microsoft Identity
// Platform that Microsoft strongly recommends verifying in addition to
// the per-subscription clientState. This package fetches and caches the
// JWKS from
//   https://login.microsoftonline.com/common/discovery/v2.0/keys
// and exposes a simple Validate(token, expectedAudience) check.
const graphMSAJWKS = "https://login.microsoftonline.com/common/discovery/v2.0/keys"

// GraphTokenValidator caches Microsoft's signing keys.
type GraphTokenValidator struct {
	http   *http.Client
	mu     sync.RWMutex
	keys   map[string]*rsa.PublicKey
	at     time.Time
}

func NewGraphTokenValidator() *GraphTokenValidator {
	return &GraphTokenValidator{
		http: safehttp.NewExternalClient(10 * time.Second),
		keys: map[string]*rsa.PublicKey{},
	}
}

// Validate checks a single validationToken JWT. expectedAudience is the
// app id of the bot/listener (i.e. the same client_id used when creating
// the subscription). On success returns nil.
func (v *GraphTokenValidator) Validate(ctx context.Context, token, expectedAudience string) error {
	if token == "" {
		return errors.New("empty token")
	}
	parsed, err := jwt.Parse(token, func(t *jwt.Token) (interface{}, error) {
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
		return fmt.Errorf("verify: %w", err)
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok || !parsed.Valid {
		return errors.New("invalid claims")
	}
	if expectedAudience != "" {
		match := false
		switch aud := claims["aud"].(type) {
		case string:
			match = aud == expectedAudience
		case []interface{}:
			for _, a := range aud {
				if s, ok := a.(string); ok && s == expectedAudience {
					match = true
					break
				}
			}
		}
		if !match {
			return errors.New("aud mismatch")
		}
	}
	if iss, _ := claims["iss"].(string); !strings.Contains(iss, "sts.windows.net") && !strings.Contains(iss, "login.microsoftonline.com") {
		return fmt.Errorf("iss mismatch: %s", iss)
	}
	return nil
}

func (v *GraphTokenValidator) keyByID(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	k, ok := v.keys[kid]
	stale := time.Since(v.at) > 12*time.Hour
	v.mu.RUnlock()
	if ok && !stale {
		return k, nil
	}
	if err := v.refresh(ctx); err != nil {
		return nil, err
	}
	v.mu.RLock()
	k = v.keys[kid]
	v.mu.RUnlock()
	if k == nil {
		return nil, fmt.Errorf("kid %s not in jwks", kid)
	}
	return k, nil
}

func (v *GraphTokenValidator) refresh(ctx context.Context) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, graphMSAJWKS, nil)
	resp, err := v.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 256*1024))
	var set struct {
		Keys []struct {
			Kid string `json:"kid"`
			Kty string `json:"kty"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &set); err != nil {
		return err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.keys = make(map[string]*rsa.PublicKey, len(set.Keys))
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.N == "" || k.E == "" {
			continue
		}
		pub, err := jwkToRSA(k.N, k.E)
		if err != nil {
			continue
		}
		v.keys[k.Kid] = pub
	}
	v.at = time.Now()
	return nil
}
