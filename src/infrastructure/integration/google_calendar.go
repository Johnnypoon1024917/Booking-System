// Google Calendar integration.
//
// Mirrors the Microsoft Graph adapter at the surface level: tokens are
// obtained via OAuth2 service-account JWT bearer flow (the only flow
// that does not require an interactive consent for tenant-wide
// calendar writes), and CRUD targets the v3 Events API.
//
// We support exactly the operations the sync use case needs:
//
//	UpsertEvent  -> POST /calendars/{calId}/events or PATCH on existing
//	DeleteEvent  -> DELETE /calendars/{calId}/events/{evId}
//
// Authorization: a Google Workspace tenant grants this app's service
// account "domain-wide delegation" via the Admin console; the JWT we
// craft asks for an access token scoped to a specific calendar
// (typically a room resource or the host user's calendar) and lasts an
// hour. Tokens are cached per (service_account_email, target_calendar)
// in-memory.
package integration

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"fsd-mrbs/src/infrastructure/safehttp"
)

const (
	googleTokenURL  = "https://oauth2.googleapis.com/token"
	googleCalendarBase = "https://www.googleapis.com/calendar/v3"
	googleScope     = "https://www.googleapis.com/auth/calendar.events"
)

// GoogleClient talks to Google Calendar using domain-wide delegated
// service-account credentials.
type GoogleClient struct {
	http   *http.Client
	tokens sync.Map // key = serviceAccountEmail + "/" + subject -> *googleToken
}

type googleToken struct {
	access  string
	expires time.Time
}

func NewGoogleClient(timeout time.Duration) *GoogleClient {
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	return &GoogleClient{http: safehttp.NewExternalClient(timeout)}
}

// GoogleCreds is the parsed service-account JSON Google emits when you
// download a key from the cloud console.
type GoogleCreds struct {
	ClientEmail string `json:"client_email"`
	PrivateKey  string `json:"private_key"`
	TokenURI    string `json:"token_uri"`
}

// ParseCreds unmarshals a Google service-account JSON key.
func ParseCreds(blob []byte) (*GoogleCreds, error) {
	var c GoogleCreds
	if err := json.Unmarshal(blob, &c); err != nil {
		return nil, fmt.Errorf("parse google creds: %w", err)
	}
	if c.ClientEmail == "" || c.PrivateKey == "" {
		return nil, errors.New("google creds missing client_email or private_key")
	}
	if c.TokenURI == "" {
		c.TokenURI = googleTokenURL
	}
	return &c, nil
}

// Token returns a non-expired access token impersonating `subject`
// (typically the room mailbox or the host's email). Cached for the JWT
// lifetime.
func (g *GoogleClient) Token(ctx context.Context, creds *GoogleCreds, subject string) (string, error) {
	key := creds.ClientEmail + "/" + subject
	if v, ok := g.tokens.Load(key); ok {
		t := v.(*googleToken)
		if time.Until(t.expires) > 60*time.Second {
			return t.access, nil
		}
	}
	signed, err := signServiceAccountJWT(creds, subject)
	if err != nil {
		return "", err
	}
	form := url.Values{}
	form.Set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer")
	form.Set("assertion", signed)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, creds.TokenURI, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := g.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("google token: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("google token: %s: %s", resp.Status, string(body))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", fmt.Errorf("google token parse: %w", err)
	}
	entry := &googleToken{access: tok.AccessToken, expires: time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)}
	g.tokens.Store(key, entry)
	return entry.access, nil
}

// GoogleEvent is the minimum we read/write. The Google API accepts many
// more fields but we deliberately scope down to the booking shape.
type GoogleEvent struct {
	ID          string `json:"id,omitempty"`
	Summary     string `json:"summary"`
	Description string `json:"description,omitempty"`
	Location    string `json:"location,omitempty"`
	Start       struct {
		DateTime string `json:"dateTime"`
		TimeZone string `json:"timeZone,omitempty"`
	} `json:"start"`
	End struct {
		DateTime string `json:"dateTime"`
		TimeZone string `json:"timeZone,omitempty"`
	} `json:"end"`
	Status string `json:"status,omitempty"` // "confirmed" | "cancelled"
}

// UpsertEvent inserts a new event or patches an existing one. The
// remoteID, if supplied, switches to PATCH.
func (g *GoogleClient) UpsertEvent(ctx context.Context, creds *GoogleCreds, subject, calID string, ev GoogleEvent) (string, error) {
	token, err := g.Token(ctx, creds, subject)
	if err != nil {
		return "", err
	}
	method := http.MethodPost
	endpoint := fmt.Sprintf("%s/calendars/%s/events", googleCalendarBase, url.PathEscape(calID))
	if ev.ID != "" {
		method = http.MethodPatch
		endpoint = fmt.Sprintf("%s/calendars/%s/events/%s",
			googleCalendarBase, url.PathEscape(calID), url.PathEscape(ev.ID))
	}
	body, _ := json.Marshal(ev)
	req, _ := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("google upsert: %w", err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode/100 != 2 {
		return "", fmt.Errorf("google upsert: %s: %s", resp.Status, string(out))
	}
	var ret struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(out, &ret)
	return ret.ID, nil
}

// DeleteEvent removes an event. 404 is treated as success — the local
// row is the source of truth, so a missing remote event is fine.
func (g *GoogleClient) DeleteEvent(ctx context.Context, creds *GoogleCreds, subject, calID, eventID string) error {
	token, err := g.Token(ctx, creds, subject)
	if err != nil {
		return err
	}
	endpoint := fmt.Sprintf("%s/calendars/%s/events/%s",
		googleCalendarBase, url.PathEscape(calID), url.PathEscape(eventID))
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete, endpoint, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := g.http.Do(req)
	if err != nil {
		return fmt.Errorf("google delete: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone || resp.StatusCode/100 == 2 {
		return nil
	}
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 8*1024))
	return fmt.Errorf("google delete: %s: %s", resp.Status, string(out))
}

// signServiceAccountJWT crafts the RS256 JWT Google expects in the
// jwt-bearer grant. The subject is the principal the access token will
// act as (typically the room mailbox or the host user).
func signServiceAccountJWT(creds *GoogleCreds, subject string) (string, error) {
	block, _ := pem.Decode([]byte(creds.PrivateKey))
	if block == nil {
		return "", errors.New("google creds: PEM block not found in private_key")
	}
	var rsaKey *rsa.PrivateKey
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		rsaKey = k
	} else if k2, err := x509.ParsePKCS8PrivateKey(block.Bytes); err == nil {
		if rk, ok := k2.(*rsa.PrivateKey); ok {
			rsaKey = rk
		}
	}
	if rsaKey == nil {
		return "", errors.New("google creds: private_key is not RSA")
	}
	now := time.Now().Unix()
	header := map[string]string{"alg": "RS256", "typ": "JWT"}
	claims := map[string]interface{}{
		"iss":   creds.ClientEmail,
		"scope": googleScope,
		"aud":   creds.TokenURI,
		"iat":   now,
		"exp":   now + 3600,
	}
	if subject != "" {
		claims["sub"] = subject
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	hash := sha256.Sum256([]byte(signingInput))
	sig, err := rsa.SignPKCS1v15(nil, rsaKey, crypto.SHA256, hash[:])
	if err != nil {
		return "", fmt.Errorf("sign jwt: %w", err)
	}
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}
