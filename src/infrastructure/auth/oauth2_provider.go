// Package auth — OAuth2 / OpenID Connect identity provider.
//
// The implementation is a minimal but correct OIDC Authorization Code +
// PKCE flow. It does NOT use the OAuth2 Resource Owner Password Credentials
// grant — Microsoft, Google, and most modern IdPs have deprecated that
// grant and it is incompatible with MFA / Conditional Access.
//
// Lifecycle:
//
//  1. The web handler calls StartAuthorization to mint a state + PKCE
//     verifier pair, stores them in a short-lived server-side cache, and
//     redirects the user to AuthURL with the matching challenge.
//  2. The IdP redirects back with code + state.
//  3. HandleCallback exchanges the code at TokenURL (using the stored
//     verifier), validates the id_token signature against JWKS, validates
//     iss / aud / exp / nonce, and returns the resulting user claims.
//
// Token revocation and refresh are out of scope for the initial cut; the
// API issues its own session JWT after a successful callback, so the IdP
// access token is discarded.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"fsd-mrbs/src/domain/auth"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/safehttp"

	"github.com/golang-jwt/jwt/v5"
)

// OAuth2Config holds the configuration for an OAuth2 / OIDC provider.
//
// The Issuer field is REQUIRED for id_token validation per the OIDC spec
// (the iss claim of the token must match this value byte-for-byte). The
// JWKSURL is populated from the issuer's discovery document or supplied
// directly by the tenant for IdPs without a public discovery endpoint.
type OAuth2Config struct {
	ClientID     string
	ClientSecret string
	Issuer       string // canonical OIDC issuer; must equal id_token "iss"
	AuthURL      string
	TokenURL     string
	JWKSURL      string
	UserInfoURL  string
	RedirectURL  string
	Scopes       []string
	ProviderName string // "azure" | "google" | "okta" | …
}

// OAuth2Provider implements IdentityProvider plus the OIDC code-flow
// helpers used by the login handler.
type OAuth2Provider struct {
	config OAuth2Config

	http *http.Client

	// JWKS cache: maps kid -> *rsa.PublicKey. Refreshed lazily when a
	// token references an unknown kid; capped at 15 minutes regardless
	// of cache hits to pick up key rotation.
	mu         sync.RWMutex
	keys       map[string]*rsa.PublicKey
	keysAt     time.Time
	keyTTL     time.Duration
}

func NewOAuth2Provider(config OAuth2Config) *OAuth2Provider {
	return &OAuth2Provider{
		config: config,
		http:   safehttp.NewExternalClient(10 * time.Second),
		keys:   map[string]*rsa.PublicKey{},
		keyTTL: 15 * time.Minute,
	}
}

// Authenticate is not supported for OIDC — the password grant is
// deprecated. The login handler routes OIDC tenants through
// StartAuthorization / HandleCallback instead.
func (p *OAuth2Provider) Authenticate(ctx context.Context, username, password string) (*user.User, error) {
	return nil, fmt.Errorf("%w: use OIDC authorization code flow", auth.ErrNotImplemented)
}

// SyncUser is a no-op until SCIM provisioning is wired into the OIDC
// callback; the JIT user upsert in HandleCallback covers the common case.
func (p *OAuth2Provider) SyncUser(ctx context.Context, userID string) error {
	return nil
}

// CheckDisabled would query the IdP's user-management API. Most IdPs
// disallow it without per-tenant admin consent, so we treat absence as
// "active" and rely on the IdP refusing the next token exchange when an
// account is disabled.
func (p *OAuth2Provider) CheckDisabled(ctx context.Context, userID string) (bool, error) {
	return false, nil
}

var _ auth.IdentityProvider = (*OAuth2Provider)(nil)

func (p *OAuth2Provider) GetProviderType() auth.ProviderType { return auth.ProviderTypeOAuth2 }

// Health probes the JWKS endpoint to ensure the IdP is reachable and is
// publishing keys the system can use.
func (p *OAuth2Provider) Health(ctx context.Context) error {
	if p.config.JWKSURL == "" {
		return errors.New("oidc: jwks_url not configured")
	}
	if _, err := p.refreshKeys(ctx); err != nil {
		return fmt.Errorf("oidc health: %w", err)
	}
	return nil
}

// AuthorizationRequest is the artefact returned by StartAuthorization;
// the caller persists `State` + `Verifier` server-side keyed by State,
// and redirects the browser to URL.
type AuthorizationRequest struct {
	URL      string
	State    string
	Nonce    string
	Verifier string // PKCE code_verifier — store, do not expose to client
}

// StartAuthorization composes the IdP redirect URL with PKCE S256 and a
// fresh state + nonce. The caller is expected to store State, Nonce, and
// Verifier server-side until HandleCallback runs.
func (p *OAuth2Provider) StartAuthorization(extraScopes ...string) (AuthorizationRequest, error) {
	state, err := randomURLSafe(32)
	if err != nil {
		return AuthorizationRequest{}, err
	}
	nonce, err := randomURLSafe(32)
	if err != nil {
		return AuthorizationRequest{}, err
	}
	verifier, err := randomURLSafe(48)
	if err != nil {
		return AuthorizationRequest{}, err
	}
	challenge := codeChallengeS256(verifier)

	scopes := append([]string{"openid", "profile", "email"}, p.config.Scopes...)
	scopes = append(scopes, extraScopes...)

	q := url.Values{}
	q.Set("response_type", "code")
	q.Set("client_id", p.config.ClientID)
	q.Set("redirect_uri", p.config.RedirectURL)
	q.Set("scope", strings.Join(dedupe(scopes), " "))
	q.Set("state", state)
	q.Set("nonce", nonce)
	q.Set("code_challenge", challenge)
	q.Set("code_challenge_method", "S256")
	return AuthorizationRequest{
		URL:      p.config.AuthURL + "?" + q.Encode(),
		State:    state,
		Nonce:    nonce,
		Verifier: verifier,
	}, nil
}

// IDClaims is the subset of OIDC id_token claims we propagate to the
// session JWT. Issuer, audience, and nonce are validated, not returned.
type IDClaims struct {
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	GivenName     string
	FamilyName    string
	Roles         []string
}

// HandleCallback exchanges the authorization code for tokens, validates
// the id_token, and returns the projected user claims. The caller MUST
// pass back the original nonce + verifier they generated in
// StartAuthorization (typically retrieved from the server-side state
// store keyed by `state`).
func (p *OAuth2Provider) HandleCallback(ctx context.Context, code, nonce, verifier string) (*IDClaims, error) {
	if code == "" || verifier == "" {
		return nil, errors.New("oidc: missing code or verifier")
	}
	form := url.Values{}
	form.Set("grant_type", "authorization_code")
	form.Set("code", code)
	form.Set("client_id", p.config.ClientID)
	form.Set("client_secret", p.config.ClientSecret)
	form.Set("redirect_uri", p.config.RedirectURL)
	form.Set("code_verifier", verifier)

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, p.config.TokenURL, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")

	resp, err := p.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("oidc token: %s: %s", resp.Status, string(body))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		IDToken     string `json:"id_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return nil, fmt.Errorf("oidc token parse: %w", err)
	}
	if tok.IDToken == "" {
		return nil, errors.New("oidc: server returned no id_token")
	}
	return p.verifyIDToken(ctx, tok.IDToken, nonce)
}

// verifyIDToken parses the id_token, looks up the signing key by kid from
// the JWKS cache (refreshing if needed), and validates iss / aud / exp /
// nonce. Returns the projected claims on success.
func (p *OAuth2Provider) verifyIDToken(ctx context.Context, raw, expectedNonce string) (*IDClaims, error) {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg(), jwt.SigningMethodRS384.Alg(), jwt.SigningMethodRS512.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithIssuer(p.config.Issuer),
		jwt.WithAudience(p.config.ClientID),
	)
	tok, err := parser.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		kid, _ := t.Header["kid"].(string)
		key, err := p.getKey(ctx, kid)
		if err != nil {
			return nil, err
		}
		return key, nil
	})
	if err != nil || !tok.Valid {
		return nil, fmt.Errorf("oidc id_token invalid: %w", err)
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return nil, errors.New("oidc id_token: unexpected claims shape")
	}
	if expectedNonce != "" {
		if got, _ := claims["nonce"].(string); got != expectedNonce {
			return nil, errors.New("oidc id_token: nonce mismatch")
		}
	}
	out := &IDClaims{
		Subject: stringClaim(claims, "sub"),
		Email:   stringClaim(claims, "email"),
		Name:    stringClaim(claims, "name"),
		GivenName:  stringClaim(claims, "given_name"),
		FamilyName: stringClaim(claims, "family_name"),
	}
	if v, ok := claims["email_verified"].(bool); ok {
		out.EmailVerified = v
	}
	if rs, ok := claims["roles"].([]interface{}); ok {
		for _, r := range rs {
			if s, ok := r.(string); ok {
				out.Roles = append(out.Roles, s)
			}
		}
	}
	if out.Subject == "" {
		return nil, errors.New("oidc id_token missing sub")
	}
	return out, nil
}

// getKey returns the public key for `kid` from the JWKS cache. If the
// kid is unknown OR the cache is older than keyTTL, the JWKS is refreshed
// and the lookup is retried once.
func (p *OAuth2Provider) getKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	p.mu.RLock()
	if time.Since(p.keysAt) < p.keyTTL {
		if k, ok := p.keys[kid]; ok {
			p.mu.RUnlock()
			return k, nil
		}
	}
	p.mu.RUnlock()
	keys, err := p.refreshKeys(ctx)
	if err != nil {
		return nil, err
	}
	if k, ok := keys[kid]; ok {
		return k, nil
	}
	return nil, fmt.Errorf("oidc: unknown signing key kid=%q", kid)
}

func (p *OAuth2Provider) refreshKeys(ctx context.Context) (map[string]*rsa.PublicKey, error) {
	if p.config.JWKSURL == "" {
		return nil, errors.New("oidc: jwks_url not configured")
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, p.config.JWKSURL, nil)
	resp, err := p.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("oidc jwks fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("oidc jwks: %s", resp.Status)
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var set struct {
		Keys []struct {
			Kty string `json:"kty"`
			Use string `json:"use"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
			Alg string `json:"alg"`
		} `json:"keys"`
	}
	if err := json.Unmarshal(body, &set); err != nil {
		return nil, fmt.Errorf("oidc jwks parse: %w", err)
	}
	out := map[string]*rsa.PublicKey{}
	for _, k := range set.Keys {
		if k.Kty != "RSA" || k.Kid == "" {
			continue
		}
		nBytes, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eBytes, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		eInt := 0
		for _, b := range eBytes {
			eInt = eInt<<8 | int(b)
		}
		out[k.Kid] = &rsa.PublicKey{N: new(big.Int).SetBytes(nBytes), E: eInt}
	}
	p.mu.Lock()
	p.keys = out
	p.keysAt = time.Now()
	p.mu.Unlock()
	return out, nil
}

// --- helpers ---

func randomURLSafe(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func codeChallengeS256(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func dedupe(in []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

func stringClaim(m jwt.MapClaims, k string) string {
	v, _ := m[k].(string)
	return v
}
