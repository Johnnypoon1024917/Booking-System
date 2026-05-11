// Package integration ships the persistence and runtime adapters for
// external integrations (Microsoft Graph, Google, Zoom). The XOR/base64
// secret obfuscation here is a stop-gap — production should switch to
// envelope encryption with KMS / Vault. The trade-off is documented at
// the top of migration 007.
package integration

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"os"
)

// secretKey is loaded once at process start. Set INTEGRATION_SECRET_KEY
// (≥ 32 bytes, base64) in production. In dev a random key is used so the
// binary still runs, but secrets won't survive a restart — fine for a
// fresh deploy, not fine for "I rebooted my server".
var secretKey = loadSecretKey()

func loadSecretKey() []byte {
	if v := os.Getenv("INTEGRATION_SECRET_KEY"); v != "" {
		k, err := base64.StdEncoding.DecodeString(v)
		if err == nil && len(k) >= 32 {
			return k
		}
	}
	k := make([]byte, 32)
	if _, err := rand.Read(k); err != nil {
		panic(err)
	}
	return k
}

// Obfuscate returns a base64-encoded XOR of the input against secretKey
// (rotating). Not a substitute for real encryption — just keeps casual
// "select * from integration_credentials" reads from showing plaintext.
func Obfuscate(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	b := []byte(plaintext)
	out := make([]byte, len(b))
	for i, c := range b {
		out[i] = c ^ secretKey[i%len(secretKey)]
	}
	return "obf:" + base64.StdEncoding.EncodeToString(out)
}

// Reveal reverses Obfuscate. If the input lacks the "obf:" prefix it is
// returned as-is (so legacy plaintext rows continue to work).
func Reveal(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	if len(stored) < 4 || stored[:4] != "obf:" {
		return stored, nil
	}
	raw, err := base64.StdEncoding.DecodeString(stored[4:])
	if err != nil {
		return "", err
	}
	out := make([]byte, len(raw))
	for i, c := range raw {
		out[i] = c ^ secretKey[i%len(secretKey)]
	}
	return string(out), nil
}

// ErrNotFound is returned when a credential is missing — handlers
// translate it to 404.
var ErrNotFound = errors.New("integration credential not found")
