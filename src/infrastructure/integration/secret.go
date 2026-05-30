// Package integration ships the persistence and runtime adapters for
// external integrations (Microsoft Graph, Google, Zoom).
//
// Stored credentials are sealed with AES-256-GCM. The key comes from
// INTEGRATION_SECRET_KEY (base64-encoded 32 bytes); the binary refuses to
// start without it unless ALLOW_DEV_INTEGRATION_EPHEMERAL=true is set for
// local development. The on-disk format is:
//
//	"enc:v1:" || base64( nonce(12) || ciphertext || tag(16) )
//
// Records written by older versions used a rotating-XOR scheme prefixed
// with "obf:". Reveal still accepts those for backward compatibility so
// existing tenants don't lose their integrations on upgrade — operators
// should re-save each credential through the admin UI to migrate it to
// AES-GCM (the handler always writes the new format).
package integration

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"strings"

	"fsd-mrbs/src/infrastructure/kms"
)

// secretKey is the legacy ungrouped key (no version tag in the
// envelope). New encryption always goes through the KMS provider; this
// stays around so records written before Phase 4 can still be decrypted
// without forcing a re-save.
var secretKey = loadLegacySecretKey()

// kmsProvider supplies the active versioned data-encryption key. When
// nil, we fall back to secretKey for both reads and writes (legacy
// mode); the process aborts at boot if neither path produced a key.
var kmsProvider = loadKMSProvider()

// activeKMSVer is the version label the KMS provider returned at
// startup, recorded once so encrypt-time doesn't re-query on every
// request. Empty when running in legacy mode.
var activeKMSVer = resolveActiveVersion()

// runningUnderGoTest detects the `go test` binary name so we can
// auto-enable the ephemeral-key escape hatch in tests. Without this,
// any test in any package that transitively imports integration would
// fail at init time with "no INTEGRATION_SECRET_KEY" — even if the
// test itself doesn't touch encryption. The detection is conservative
// (only ".test" suffix on the binary, which `go test` always sets) so
// production builds are unaffected.
func runningUnderGoTest() bool {
	if len(os.Args) == 0 {
		return false
	}
	bin := os.Args[0]
	return strings.HasSuffix(bin, ".test") || strings.HasSuffix(bin, ".test.exe")
}

func loadLegacySecretKey() []byte {
	if v := os.Getenv("INTEGRATION_SECRET_KEY"); v != "" {
		if k, err := base64.StdEncoding.DecodeString(v); err == nil && len(k) == 32 {
			return k
		}
		if len(v) == 64 {
			k := make([]byte, 32)
			if _, err := fmt.Sscanf(v, "%x", &k); err == nil {
				return k
			}
		}
		log.Fatal("INTEGRATION_SECRET_KEY must be a 32-byte key encoded as base64 or hex.")
	}
	if strings.EqualFold(os.Getenv("ALLOW_DEV_INTEGRATION_EPHEMERAL"), "true") || runningUnderGoTest() {
		k := make([]byte, 32)
		if _, err := rand.Read(k); err != nil {
			panic(err)
		}
		if !runningUnderGoTest() {
			log.Println("WARNING: ALLOW_DEV_INTEGRATION_EPHEMERAL=true — using ephemeral integration key. Existing ciphertexts will be undecryptable after restart.")
		}
		return k
	}
	return nil
}

func loadKMSProvider() kms.Provider {
	if strings.ToLower(strings.TrimSpace(os.Getenv("KMS_PROVIDER"))) == "" && secretKey != nil {
		// Legacy mode: KMS_PROVIDER not configured and we already have a
		// usable env key. Skip provider init so we don't double-process
		// the same env var.
		return nil
	}
	p, err := kms.New(context.Background())
	if err != nil {
		if secretKey != nil {
			log.Printf("integration secret: kms init failed (%v) — running in legacy mode", err)
			return nil
		}
		log.Fatalf("integration secret: %v", err)
	}
	return p
}

func resolveActiveVersion() string {
	if kmsProvider == nil {
		return ""
	}
	_, ver, err := kmsProvider.ActiveKey(context.Background())
	if err != nil {
		log.Fatalf("integration secret: kms active key: %v", err)
	}
	return ver
}

// keyForVersion returns the AES-256 key to use for a record tagged with
// `version`. Empty version means a legacy "enc:v1:" record predating
// the version-tagged envelope, decrypted with secretKey.
func keyForVersion(version string) ([]byte, error) {
	if version == "" {
		if secretKey == nil {
			return nil, errors.New("integration secret: legacy record but INTEGRATION_SECRET_KEY is not configured")
		}
		return secretKey, nil
	}
	if kmsProvider != nil {
		k, err := kmsProvider.KeyByVersion(context.Background(), version)
		if err == nil {
			return k, nil
		}
		if errors.Is(err, kms.ErrUnknownVersion) && secretKey != nil && version == "v1" {
			return secretKey, nil
		}
		return nil, err
	}
	if secretKey != nil && (version == "v1" || version == "") {
		return secretKey, nil
	}
	return nil, fmt.Errorf("integration secret: no key configured for version %q", version)
}

// activeKey returns the key + version label new ciphertexts should use.
func activeKey() ([]byte, string) {
	if kmsProvider != nil {
		k, ver, err := kmsProvider.ActiveKey(context.Background())
		if err == nil {
			return k, ver
		}
		log.Printf("integration secret: kms active key fetch failed (%v) — falling back to legacy", err)
	}
	if secretKey != nil {
		return secretKey, "v1"
	}
	log.Fatal("integration secret: no encryption key available")
	return nil, ""
}

const (
	// Envelope prefixes. v1 was the pre-Phase-4 single-key format that
	// stored only "enc:v1:" + base64 ciphertext. From Phase 4 onwards
	// new records use the versioned form "enc:<ver>:" so the KMS
	// provider can rotate keys without invalidating old records.
	prefixV1     = "enc:v1:"
	prefixGCMTag = "enc:"   // versioned form: enc:<ver>:<b64>
	prefixXOR    = "obf:"   // legacy rotating-XOR; pre-Phase-0
)

// Obfuscate seals plaintext with AES-256-GCM using the KMS provider's
// active key, tagging the envelope with the key version so rotation
// remains decryptable.
func Obfuscate(plaintext string) string {
	if plaintext == "" {
		return ""
	}
	key, version := activeKey()
	block, err := aes.NewCipher(key)
	if err != nil {
		log.Fatalf("aes new cipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		log.Fatalf("aes gcm: %v", err)
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		log.Fatalf("nonce: %v", err)
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return prefixGCMTag + version + ":" + base64.StdEncoding.EncodeToString(sealed)
}

// Reveal returns the plaintext of a stored credential. It accepts:
//   - "enc:<ver>:..." — versioned AES-GCM envelope (Phase 4+).
//   - "enc:v1:..."    — pre-Phase-4 envelope; decrypted with legacy key.
//   - "obf:..."       — pre-Phase-0 rotating-XOR; kept for in-place upgrade.
//   - anything else   — returned unchanged (legacy plaintext rows).
func Reveal(stored string) (string, error) {
	if stored == "" {
		return "", nil
	}
	switch {
	case strings.HasPrefix(stored, prefixGCMTag):
		// Split "enc:<ver>:<b64>" — version is the segment between the
		// two colons.
		rest := stored[len(prefixGCMTag):]
		i := strings.IndexByte(rest, ':')
		if i < 0 {
			return "", errors.New("malformed enc envelope: missing version delimiter")
		}
		return decryptGCM(rest[:i], rest[i+1:])
	case strings.HasPrefix(stored, prefixXOR):
		return decryptXORLegacy(stored[len(prefixXOR):])
	default:
		return stored, nil
	}
}

func decryptGCM(version, b64 string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	key, err := keyForVersion(version)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	nonce, ct := raw[:gcm.NonceSize()], raw[gcm.NonceSize():]
	pt, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return "", fmt.Errorf("open: %w", err)
	}
	return string(pt), nil
}

// decryptXORLegacy unwraps records written by the pre-Phase-0
// obfuscation scheme. It is retained only so existing rows can be read
// once and then re-encrypted in AES-GCM form on the next admin save.
// The XOR scheme keyed off whatever secretKey held at the time, so we
// require secretKey here (the KMS provider doesn't surface it).
func decryptXORLegacy(b64 string) (string, error) {
	if secretKey == nil {
		return "", errors.New("legacy XOR record but INTEGRATION_SECRET_KEY is not configured")
	}
	raw, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return "", err
	}
	out := make([]byte, len(raw))
	for i, c := range raw {
		out[i] = c ^ secretKey[i%len(secretKey)]
	}
	return string(out), nil
}

// silence the unused-variable warning for activeKMSVer which exists for
// log lines and operator visibility. Once the integration_credentials
// admin UI exposes the active key version, this will be referenced.
var _ = activeKMSVer

// silence the unused warning on prefixV1 — it documents the legacy
// envelope shape callers might still hit through Reveal.
var _ = prefixV1

// ErrNotFound is returned when a credential is missing — handlers
// translate it to 404.
var ErrNotFound = errors.New("integration credential not found")
