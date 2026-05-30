// Package kms abstracts the secret-material backend used for envelope
// encryption of stored credentials. The package intentionally exposes a
// narrow surface — "give me the active 32-byte data key" and "give me
// a previous key for decryption" — so we can switch providers (Vault,
// AWS KMS, Azure Key Vault, GCP KMS) without touching the call sites.
//
// Threat model:
//
//   * Operators run a long-lived KEK in their cloud KMS. The KEK never
//     leaves the KMS boundary; we only see the DEK it wraps.
//   * On boot, the API + workers fetch the active DEK once and cache
//     it in memory for the process lifetime. Rotation is cooperative:
//     ops rotates the KEK in the KMS, restarts the API, and the new
//     DEK takes effect. Ciphertexts written under the old DEK remain
//     decryptable because every record carries the DEK version as its
//     prefix (`enc:v2:` etc).
//
// Provider selection is driven by KMS_PROVIDER:
//
//   env       — read INTEGRATION_SECRET_KEY from env (current default)
//   vault     — HashiCorp Vault transit engine
//   aws       — AWS KMS Decrypt of KMS_KEY_CIPHERTEXT
//   azure     — Azure Key Vault GetSecret
//   gcp       — GCP KMS Decrypt
//
// Only the `env` provider is implemented in this initial cut; the
// others are stubs that error with a clear "configure provider"
// message so a misconfigured deploy fails closed instead of running
// with no real key material.
package kms

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

// Provider returns the active data-encryption key plus, optionally, a
// list of historical keys still needed to decrypt legacy ciphertexts.
// All keys MUST be 32 bytes (AES-256 / HMAC-SHA-256 sized).
type Provider interface {
	// ActiveKey returns the current key plus its version label (e.g.
	// "v1"). The version is folded into ciphertext envelopes so older
	// records remain decryptable after rotation.
	ActiveKey(ctx context.Context) (key []byte, version string, err error)

	// KeyByVersion looks up a historical key. Returns ErrUnknownVersion
	// when the version isn't known — callers should refuse the
	// decryption rather than guess.
	KeyByVersion(ctx context.Context, version string) ([]byte, error)

	// Name returns the provider's identifier for log lines.
	Name() string
}

// ErrUnknownVersion is returned by KeyByVersion when the requested
// version is not present in the provider's store.
var ErrUnknownVersion = errors.New("kms: unknown key version")

// New returns a Provider configured from the environment. Selection:
//
//   KMS_PROVIDER=env (default)  -> reads INTEGRATION_SECRET_KEY[_v<N>]
//                                  vars; rotation by adding the new
//                                  variable + bumping KMS_ACTIVE_VERSION.
//   KMS_PROVIDER=vault          -> not yet implemented in this revision
//   KMS_PROVIDER=aws            -> not yet implemented
//   KMS_PROVIDER=azure          -> not yet implemented
//   KMS_PROVIDER=gcp            -> not yet implemented
//
// New caches the resolved provider for the process lifetime; restart
// to pick up a new KMS_PROVIDER value.
func New(ctx context.Context) (Provider, error) {
	name := strings.ToLower(strings.TrimSpace(os.Getenv("KMS_PROVIDER")))
	if name == "" {
		name = "env"
	}
	switch name {
	case "env":
		return newEnvProvider()
	case "vault", "aws", "azure", "gcp":
		return nil, fmt.Errorf("kms: provider %q wired in interface but not yet implemented — please configure KMS_PROVIDER=env or wait for the provider rollout", name)
	default:
		return nil, fmt.Errorf("kms: unknown provider %q", name)
	}
}

// ---------- env provider ----------

// envProvider reads keys from INTEGRATION_SECRET_KEY_v<N> variables.
// On first call it scans the env, builds an immutable version map, and
// caches it. Rotation: set a new variable (INTEGRATION_SECRET_KEY_v2),
// flip KMS_ACTIVE_VERSION=v2, restart.
type envProvider struct {
	once    sync.Once
	keys    map[string][]byte // version -> key
	active  string
	loadErr error
}

func newEnvProvider() (*envProvider, error) {
	p := &envProvider{keys: map[string][]byte{}}
	p.load()
	if p.loadErr != nil {
		return nil, p.loadErr
	}
	return p, nil
}

func (p *envProvider) load() {
	p.once.Do(func() {
		// Legacy path: INTEGRATION_SECRET_KEY (unversioned). Treat it as
		// version "v1" so existing ciphertexts written with the
		// pre-Phase-4 envelope ("enc:v1:") decrypt without migration.
		if v := os.Getenv("INTEGRATION_SECRET_KEY"); v != "" {
			k, err := decodeKey(v)
			if err != nil {
				p.loadErr = fmt.Errorf("kms env: INTEGRATION_SECRET_KEY: %w", err)
				return
			}
			p.keys["v1"] = k
			p.active = "v1"
		}
		// Versioned entries override / extend the legacy one.
		for _, e := range os.Environ() {
			const prefix = "INTEGRATION_SECRET_KEY_"
			if !strings.HasPrefix(e, prefix) {
				continue
			}
			eq := strings.IndexByte(e, '=')
			if eq < 0 {
				continue
			}
			ver := strings.ToLower(e[len(prefix):eq])
			k, err := decodeKey(e[eq+1:])
			if err != nil {
				p.loadErr = fmt.Errorf("kms env: %s: %w", e[:eq], err)
				return
			}
			p.keys[ver] = k
		}
		if v := strings.ToLower(strings.TrimSpace(os.Getenv("KMS_ACTIVE_VERSION"))); v != "" {
			if _, ok := p.keys[v]; !ok {
				p.loadErr = fmt.Errorf("kms env: KMS_ACTIVE_VERSION=%s but no key by that name", v)
				return
			}
			p.active = v
		}
		if p.active == "" || len(p.keys) == 0 {
			p.loadErr = errors.New("kms env: no INTEGRATION_SECRET_KEY[_v*] variable set")
			return
		}
	})
}

func (p *envProvider) ActiveKey(_ context.Context) ([]byte, string, error) {
	p.load()
	if p.loadErr != nil {
		return nil, "", p.loadErr
	}
	return p.keys[p.active], p.active, nil
}

func (p *envProvider) KeyByVersion(_ context.Context, version string) ([]byte, error) {
	p.load()
	if p.loadErr != nil {
		return nil, p.loadErr
	}
	k, ok := p.keys[strings.ToLower(version)]
	if !ok {
		return nil, fmt.Errorf("%w: %q", ErrUnknownVersion, version)
	}
	return k, nil
}

func (p *envProvider) Name() string { return "env" }

// decodeKey accepts the same shapes integration/secret.go did: 32-byte
// raw key encoded as base64 or 64 hex characters.
func decodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if k, err := base64.StdEncoding.DecodeString(s); err == nil && len(k) == 32 {
		return k, nil
	}
	if k, err := base64.RawStdEncoding.DecodeString(s); err == nil && len(k) == 32 {
		return k, nil
	}
	if len(s) == 64 {
		k := make([]byte, 32)
		if _, err := fmt.Sscanf(s, "%x", &k); err == nil {
			return k, nil
		}
	}
	return nil, errors.New("must be a 32-byte key as base64 or hex")
}

// CacheTTL is the duration after which a Provider's cached key should
// be considered stale. Provider implementations may ignore this for
// long-lived in-memory caches; it exists so a future polling provider
// can refresh on schedule rather than per call.
const CacheTTL = 15 * time.Minute
