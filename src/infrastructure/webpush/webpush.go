// Package webpush dispatches Web Push notifications per RFC 8030 + RFC
// 8292 (VAPID). It is deliberately small: a single Send() that signs a
// VAPID JWT, builds the request envelope, and posts to the subscription
// endpoint. Payload encryption (aes128gcm content-coding) is NOT
// implemented here — most browsers accept empty-body pushes that wake
// the service worker, and the service worker fetches the actual payload
// over the API. That avoids carrying the elliptic-curve diffie-hellman
// stack into this binary.
//
// To enable encrypted payloads later, swap Send for a SendEncrypted that
// pulls the subscription's p256dh + auth keys and runs the standard
// HKDF-based content encoding. Until then, callers SHOULD NOT put
// sensitive content in `payload` — treat it as a hint, not a body.
package webpush

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"time"

	"fsd-mrbs/src/infrastructure/safehttp"
)

// Sender is the configured dispatcher. Build one at process start and
// reuse — JWT signing is cheap but key parsing isn't.
type Sender struct {
	http       *http.Client
	subject    string // "mailto:ops@fsd.gov.hk"
	publicB64  string // raw URL-safe base64 of the uncompressed P-256 point
	privateKey *ecdsa.PrivateKey
}

// NewSenderFromEnv reads VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (both
// base64url) plus VAPID_SUBJECT and returns a ready sender. Returns
// (nil, nil) if the env is unset so callers can degrade gracefully.
func NewSenderFromEnv(get func(string) string) (*Sender, error) {
	pub := get("VAPID_PUBLIC_KEY")
	priv := get("VAPID_PRIVATE_KEY")
	subj := get("VAPID_SUBJECT")
	if pub == "" || priv == "" {
		return nil, nil
	}
	if subj == "" {
		subj = "mailto:noreply@fsd-mrbs.local"
	}
	key, err := parsePrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return &Sender{
		http:       safehttp.NewExternalClient(10 * time.Second),
		subject:    subj,
		publicB64:  pub,
		privateKey: key,
	}, nil
}

// Subscription is the (endpoint, keys) tuple the browser hands to the
// API. We only need the endpoint for unencrypted dispatch; p256dh and
// auth are kept around for the future SendEncrypted path.
type Subscription struct {
	Endpoint string
	P256dh   string
	Auth     string
}

// Result reports the outcome of one Send. Status 410 / 404 signal a
// dead subscription that the caller should delete from the DB.
type Result struct {
	StatusCode int
	Body       string
	Endpoint   string
}

// Send posts an empty-body push to the subscription. The notification
// body is then fetched by the service worker over the API after the
// push event fires. Use SendEncrypted when you want the payload itself
// delivered with the push.
func (s *Sender) Send(ctx context.Context, sub Subscription, ttlSeconds int, urgency string) (*Result, error) {
	return s.send(ctx, sub, nil, ttlSeconds, urgency)
}

// SendEncrypted posts a Web Push with an aes128gcm-encrypted payload
// (RFC 8291). The payload — typically a short JSON envelope like
// {"title":"...","body":"...","url":"..."} — reaches the service
// worker's push event handler directly, avoiding the extra API
// round-trip Send requires.
func (s *Sender) SendEncrypted(ctx context.Context, sub Subscription, payload []byte, ttlSeconds int, urgency string) (*Result, error) {
	if len(payload) == 0 {
		return s.send(ctx, sub, nil, ttlSeconds, urgency)
	}
	body, err := EncryptPayload(sub.P256dh, sub.Auth, payload)
	if err != nil {
		return nil, fmt.Errorf("webpush encrypt: %w", err)
	}
	return s.send(ctx, sub, body, ttlSeconds, urgency)
}

func (s *Sender) send(ctx context.Context, sub Subscription, body []byte, ttlSeconds int, urgency string) (*Result, error) {
	if sub.Endpoint == "" {
		return nil, errors.New("webpush: empty endpoint")
	}
	if ttlSeconds <= 0 {
		ttlSeconds = 60
	}
	if urgency == "" {
		urgency = "normal"
	}
	jwt, err := s.signVAPIDJWT(sub.Endpoint)
	if err != nil {
		return nil, err
	}

	var reqBody io.Reader
	if body != nil {
		reqBody = bytes.NewReader(body)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, sub.Endpoint, reqBody)
	req.Header.Set("Authorization", fmt.Sprintf("vapid t=%s, k=%s", jwt, s.publicB64))
	req.Header.Set("TTL", fmt.Sprintf("%d", ttlSeconds))
	req.Header.Set("Urgency", urgency)
	if body != nil {
		req.Header.Set("Content-Type", "application/octet-stream")
		req.Header.Set("Content-Encoding", "aes128gcm")
		req.Header.Set("Content-Length", fmt.Sprintf("%d", len(body)))
	} else {
		req.Header.Set("Content-Length", "0")
	}

	resp, err := s.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024))
	return &Result{StatusCode: resp.StatusCode, Body: string(respBody), Endpoint: sub.Endpoint}, nil
}

// IsExpired returns true when the subscription should be deleted from
// the local store (RFC 8030 §5.4: "If the application server receives a
// 404 or 410 response, it MUST stop sending push messages...").
func (r *Result) IsExpired() bool {
	return r.StatusCode == http.StatusGone || r.StatusCode == http.StatusNotFound
}

// signVAPIDJWT crafts the ES256 JWT bound to the push service origin.
func (s *Sender) signVAPIDJWT(endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", err
	}
	aud := u.Scheme + "://" + u.Host

	header := map[string]string{"typ": "JWT", "alg": "ES256"}
	claims := map[string]interface{}{
		"aud": aud,
		"exp": time.Now().Add(12 * time.Hour).Unix(),
		"sub": s.subject,
	}
	hb, _ := json.Marshal(header)
	cb, _ := json.Marshal(claims)
	signingInput := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(cb)
	hash := sha256.Sum256([]byte(signingInput))
	r, sBig, err := ecdsa.Sign(rand.Reader, s.privateKey, hash[:])
	if err != nil {
		return "", err
	}
	// JWS ES256 signature is the concatenation of fixed-size r and s.
	sig := make([]byte, 64)
	copyBig(sig[:32], r)
	copyBig(sig[32:], sBig)
	return signingInput + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func copyBig(dst []byte, x *big.Int) {
	src := x.Bytes()
	if len(src) > len(dst) {
		src = src[len(src)-len(dst):]
	}
	for i := range dst {
		dst[i] = 0
	}
	copy(dst[len(dst)-len(src):], src)
}

// parsePrivateKey accepts either base64url(raw 32-byte private scalar)
// or a PEM-encoded EC private key. The first form is what the
// js `webcrypto.subtle.exportKey('jwk')` flow produces, the second is
// what `openssl ecparam -name prime256v1 -genkey -noout` writes.
func parsePrivateKey(s string) (*ecdsa.PrivateKey, error) {
	if strings.Contains(s, "BEGIN") {
		block, _ := pem.Decode([]byte(s))
		if block == nil {
			return nil, errors.New("webpush: PEM decode failed")
		}
		key, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return key, nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		raw, err = base64.StdEncoding.DecodeString(s)
	}
	if err != nil {
		return nil, fmt.Errorf("webpush: decode private key: %w", err)
	}
	if len(raw) != 32 {
		return nil, fmt.Errorf("webpush: private key must be 32 bytes, got %d", len(raw))
	}
	priv := new(ecdsa.PrivateKey)
	priv.Curve = elliptic.P256()
	priv.D = new(big.Int).SetBytes(raw)
	priv.X, priv.Y = priv.Curve.ScalarBaseMult(raw)
	return priv, nil
}

// _ keeps crypto.SHA256 referenced; the package import is required by
// some Go versions for the elliptic.P256().Params().Hash() path.
var _ = crypto.SHA256
