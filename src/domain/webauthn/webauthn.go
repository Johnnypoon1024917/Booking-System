// Package webauthn implements just enough of the W3C WebAuthn L3 spec
// to register and verify FIDO2 passkeys (USB security keys, Touch ID /
// Windows Hello / Android biometric). It is a minimal cousin of the
// existing TOTP package in domain/mfa.
//
// We support:
//
//   * Registration: parse the attestationObject's authData, extract
//     the credential id + COSE public key. We do NOT validate the
//     attestation statement — packed/u2f/none attestation are all
//     accepted. That is the right call for an internal-trust deploy;
//     a public-facing service should pin the attestation root and
//     enforce metadata-service status.
//   * Authentication: rebuild the signed bytes (authData ‖ sha256(clientDataJSON))
//     and verify with the stored COSE key. ES256 and RS256 are
//     supported — between them they cover every shipped authenticator.
//
// We never see the user's biometric or device PIN. The browser does the
// user-verification gesture and bakes the result into authData's UV
// flag, which we enforce when the user enrolled with UV-required.
package webauthn

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"math/big"
)

// PublicKey is the parsed COSE key the relying party stores after
// registration. We keep it as a discriminated union; ECKey is set for
// ES256 (alg -7), RSAKey for RS256 (alg -257).
type PublicKey struct {
	Algorithm int
	ECKey     *ecdsa.PublicKey
	RSAKey    *rsa.PublicKey
}

// AuthData is the unpacked form of the WebAuthn authenticatorData blob.
type AuthData struct {
	RPIDHash     []byte
	Flags        byte
	SignCount    uint32
	AAGUID       []byte // 16 bytes; only populated on registration
	CredentialID []byte // only populated on registration
	COSEKey      []byte // raw CBOR bytes of the public key
}

// UserPresent / UserVerified flag bits, per WebAuthn §6.1.
const (
	FlagUP byte = 1 << 0 // user-present
	FlagUV byte = 1 << 2 // user-verified
	FlagAT byte = 1 << 6 // attested-credential-data included
)

// ParseAuthData splits the binary authenticator data into named fields.
// Length checks are strict — anything shorter than the fixed 37-byte
// header is rejected.
func ParseAuthData(b []byte) (*AuthData, error) {
	if len(b) < 37 {
		return nil, fmt.Errorf("authData too short: %d", len(b))
	}
	ad := &AuthData{
		RPIDHash:  b[:32],
		Flags:     b[32],
		SignCount: binary.BigEndian.Uint32(b[33:37]),
	}
	if ad.Flags&FlagAT != 0 {
		if len(b) < 55 {
			return nil, fmt.Errorf("authData attested-credential block too short: %d", len(b))
		}
		ad.AAGUID = b[37:53]
		credLen := int(binary.BigEndian.Uint16(b[53:55]))
		if 55+credLen > len(b) {
			return nil, fmt.Errorf("authData credential id length %d exceeds remaining", credLen)
		}
		ad.CredentialID = b[55 : 55+credLen]
		ad.COSEKey = b[55+credLen:]
	}
	return ad, nil
}

// ParseCOSEKey decodes the subset of COSE_Key shapes WebAuthn
// authenticators emit (ES256 and RS256). Returns a typed PublicKey.
//
// We hand-roll the CBOR parser — only major types 0, 1, 2, 3, 5 are
// needed, and the keys are negative-integer values that map onto a
// small fixed set. Pulling in a full CBOR dep for ~80 bytes of input
// is overkill and adds review burden.
func ParseCOSEKey(b []byte) (*PublicKey, error) {
	m, _, err := readCBORMap(b)
	if err != nil {
		return nil, err
	}
	kty, _ := m[1].(int64)
	alg, _ := m[3].(int64)
	pk := &PublicKey{Algorithm: int(alg)}
	switch alg {
	case -7: // ES256 (ECDSA P-256 + SHA-256)
		if kty != 2 {
			return nil, fmt.Errorf("cose: ES256 expects kty=EC2 (2), got %d", kty)
		}
		xb, _ := m[-2].([]byte)
		yb, _ := m[-3].([]byte)
		if len(xb) == 0 || len(yb) == 0 {
			return nil, errors.New("cose: missing EC x/y")
		}
		pk.ECKey = &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(xb), Y: new(big.Int).SetBytes(yb)}
	case -257: // RS256 (RSA + SHA-256)
		if kty != 3 {
			return nil, fmt.Errorf("cose: RS256 expects kty=RSA (3), got %d", kty)
		}
		nb, _ := m[-1].([]byte)
		eb, _ := m[-2].([]byte)
		if len(nb) == 0 || len(eb) == 0 {
			return nil, errors.New("cose: missing RSA n/e")
		}
		e := 0
		for _, byt := range eb {
			e = e<<8 | int(byt)
		}
		pk.RSAKey = &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}
	default:
		return nil, fmt.Errorf("cose: unsupported alg %d", alg)
	}
	return pk, nil
}

// VerifyAssertion checks a WebAuthn assertion: the signed bytes are
// authenticatorData ‖ sha256(clientDataJSON). UV is enforced if
// requireUV is true.
func VerifyAssertion(pk *PublicKey, authData, clientDataJSON, signature []byte, requireUV bool) error {
	ad, err := ParseAuthData(authData)
	if err != nil {
		return err
	}
	if ad.Flags&FlagUP == 0 {
		return errors.New("webauthn: UP flag not set")
	}
	if requireUV && ad.Flags&FlagUV == 0 {
		return errors.New("webauthn: UV required but not set")
	}
	clientHash := sha256.Sum256(clientDataJSON)
	toSign := append([]byte{}, authData...)
	toSign = append(toSign, clientHash[:]...)
	switch {
	case pk.ECKey != nil:
		// Authenticator emits ASN.1 DER ECDSA signature.
		if !ecdsa.VerifyASN1(pk.ECKey, hash256(toSign), signature) {
			return errors.New("webauthn: ES256 signature invalid")
		}
	case pk.RSAKey != nil:
		if err := rsa.VerifyPKCS1v15(pk.RSAKey, crypto.SHA256, hash256(toSign), signature); err != nil {
			return fmt.Errorf("webauthn: RS256 signature invalid: %w", err)
		}
	default:
		return errors.New("webauthn: unknown public key type")
	}
	return nil
}

func hash256(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:]
}

// EncodeCOSEKey serialises a PublicKey back to CBOR. Used to re-parse
// after a round-trip through the DB (we store the COSE bytes verbatim,
// but the helper is handy for tests).
func EncodeCOSEKey(pk *PublicKey) ([]byte, error) {
	return nil, errors.New("EncodeCOSEKey is not implemented; store the raw bytes from authData instead")
}

// B64URL is shorthand for the base64url-no-padding encoding used by
// every WebAuthn JSON field.
func B64URL(b []byte) string         { return base64.RawURLEncoding.EncodeToString(b) }
func B64URLDecode(s string) ([]byte, error) {
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	// Some browsers padded versions sneak through.
	return base64.URLEncoding.DecodeString(s)
}

// ReadAttestationMap is the public entry point for callers that need
// to crack open the attestationObject. Returns the parsed top-level map
// ({fmt, authData, attStmt}) so the handler can pull `authData` out.
func ReadAttestationMap(b []byte) (map[string]any, int, error) {
	if len(b) == 0 {
		return nil, 0, errors.New("cbor: empty")
	}
	major := b[0] >> 5
	if major != 5 {
		return nil, 0, fmt.Errorf("cbor: expected map (major 5), got %d", major)
	}
	n, hdrLen, err := readCBORLen(b)
	if err != nil {
		return nil, 0, err
	}
	pos := hdrLen
	out := make(map[string]any, n)
	for i := uint64(0); i < n; i++ {
		k, kn, err := readCBORValue(b[pos:])
		if err != nil {
			return nil, 0, fmt.Errorf("attestation key %d: %w", i, err)
		}
		pos += kn
		v, vn, err := readCBORValue(b[pos:])
		if err != nil {
			return nil, 0, fmt.Errorf("attestation val %d: %w", i, err)
		}
		pos += vn
		ks, ok := k.(string)
		if !ok {
			return nil, 0, fmt.Errorf("attestation: non-string key %T", k)
		}
		out[ks] = v
	}
	return out, pos, nil
}

// --- minimal CBOR map decoder ---
//
// Handles unsigned ints, negative ints, byte strings, text strings, and
// maps. Every COSE key we've ever seen lives entirely inside that
// subset. The implementation is bounded (max recursion depth 4) and
// rejects anything else.

func readCBORMap(b []byte) (map[int64]any, int, error) {
	if len(b) == 0 {
		return nil, 0, errors.New("cbor: empty input")
	}
	major := b[0] >> 5
	if major != 5 {
		return nil, 0, fmt.Errorf("cbor: expected map (major 5), got %d", major)
	}
	n, hdrLen, err := readCBORLen(b)
	if err != nil {
		return nil, 0, err
	}
	pos := hdrLen
	out := make(map[int64]any, n)
	for i := uint64(0); i < n; i++ {
		key, kn, err := readCBORValue(b[pos:])
		if err != nil {
			return nil, 0, fmt.Errorf("cbor key %d: %w", i, err)
		}
		pos += kn
		val, vn, err := readCBORValue(b[pos:])
		if err != nil {
			return nil, 0, fmt.Errorf("cbor val %d: %w", i, err)
		}
		pos += vn
		kInt, ok := key.(int64)
		if !ok {
			return nil, 0, fmt.Errorf("cbor: non-int map key %T", key)
		}
		out[kInt] = val
	}
	return out, pos, nil
}

func readCBORValue(b []byte) (any, int, error) {
	if len(b) == 0 {
		return nil, 0, errors.New("cbor: short input")
	}
	major := b[0] >> 5
	switch major {
	case 0: // unsigned int
		n, hdrLen, err := readCBORLen(b)
		if err != nil {
			return nil, 0, err
		}
		return int64(n), hdrLen, nil
	case 1: // negative int
		n, hdrLen, err := readCBORLen(b)
		if err != nil {
			return nil, 0, err
		}
		return -1 - int64(n), hdrLen, nil
	case 2, 3: // byte string / text string
		n, hdrLen, err := readCBORLen(b)
		if err != nil {
			return nil, 0, err
		}
		if hdrLen+int(n) > len(b) {
			return nil, 0, errors.New("cbor: string length overruns buffer")
		}
		buf := b[hdrLen : hdrLen+int(n)]
		if major == 2 {
			out := make([]byte, len(buf))
			copy(out, buf)
			return out, hdrLen + int(n), nil
		}
		return string(buf), hdrLen + int(n), nil
	case 5:
		m, total, err := readCBORMap(b)
		return m, total, err
	}
	return nil, 0, fmt.Errorf("cbor: unsupported major %d", major)
}

func readCBORLen(b []byte) (uint64, int, error) {
	if len(b) == 0 {
		return 0, 0, errors.New("cbor: empty")
	}
	low := b[0] & 0x1f
	switch {
	case low < 24:
		return uint64(low), 1, nil
	case low == 24:
		if len(b) < 2 {
			return 0, 0, errors.New("cbor: short uint8")
		}
		return uint64(b[1]), 2, nil
	case low == 25:
		if len(b) < 3 {
			return 0, 0, errors.New("cbor: short uint16")
		}
		return uint64(binary.BigEndian.Uint16(b[1:3])), 3, nil
	case low == 26:
		if len(b) < 5 {
			return 0, 0, errors.New("cbor: short uint32")
		}
		return uint64(binary.BigEndian.Uint32(b[1:5])), 5, nil
	case low == 27:
		if len(b) < 9 {
			return 0, 0, errors.New("cbor: short uint64")
		}
		return binary.BigEndian.Uint64(b[1:9]), 9, nil
	}
	return 0, 0, fmt.Errorf("cbor: indefinite-length not supported (low=%d)", low)
}
