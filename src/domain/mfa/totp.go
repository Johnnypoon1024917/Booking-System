// Package mfa implements the TOTP authenticator-app flow (RFC 6238) for
// step-up authentication on non-federated logins. SAML / OIDC tenants
// delegate MFA to the IdP and bypass this package entirely.
//
// The implementation uses SHA-1, 30-second steps, and 6-digit codes —
// matching Google Authenticator, Authy, Microsoft Authenticator, and any
// FIDO-aware password manager. Secrets are 20 random bytes (160 bits) so
// the otpauth:// URI fits a single QR code.
package mfa

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

const (
	stepSeconds = 30
	digits      = 6
	skewSteps   = 1 // accept current step ± 1 for clock drift
)

// GenerateSecret returns a fresh 160-bit secret encoded as RFC 4648 base32
// without padding — the form authenticator apps expect.
func GenerateSecret() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return strings.TrimRight(base32.StdEncoding.EncodeToString(raw), "="), nil
}

// OtpauthURL builds the otpauth://totp/... URI for QR-code enrolment.
// `issuer` is shown above the account name in authenticator apps; choose
// a stable string per deployment (e.g. "FSD MRBS").
func OtpauthURL(issuer, account, secret string) string {
	q := url.Values{}
	q.Set("secret", secret)
	q.Set("issuer", issuer)
	q.Set("algorithm", "SHA1")
	q.Set("digits", fmt.Sprintf("%d", digits))
	q.Set("period", fmt.Sprintf("%d", stepSeconds))
	return fmt.Sprintf("otpauth://totp/%s:%s?%s",
		url.PathEscape(issuer),
		url.PathEscape(account),
		q.Encode())
}

// Verify returns true if the supplied 6-digit code matches the user's
// secret for the current 30-second step (with ±1 step of skew tolerance).
// Comparison is constant-time.
func Verify(secret, code string) (bool, error) {
	if len(code) != digits {
		return false, errors.New("invalid code length")
	}
	key, err := decode(secret)
	if err != nil {
		return false, err
	}
	step := nowStep()
	for offset := -int64(skewSteps); offset <= int64(skewSteps); offset++ {
		candidate := generateCode(key, step+offset)
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return true, nil
		}
	}
	return false, nil
}

func nowStep() int64 { return time.Now().Unix() / stepSeconds }

func decode(secret string) ([]byte, error) {
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.ToUpper(strings.TrimSpace(secret)))
	if err != nil {
		return nil, fmt.Errorf("decode secret: %w", err)
	}
	return key, nil
}

func generateCode(key []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	mac := hmac.New(sha1.New, key)
	mac.Write(counter[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binCode := (uint32(sum[offset])&0x7f)<<24 |
		uint32(sum[offset+1])<<16 |
		uint32(sum[offset+2])<<8 |
		uint32(sum[offset+3])
	mod := uint32(1)
	for i := 0; i < digits; i++ {
		mod *= 10
	}
	return fmt.Sprintf("%0*d", digits, binCode%mod)
}
