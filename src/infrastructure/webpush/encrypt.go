// RFC 8291 message encryption for Web Push, content-encoding
// "aes128gcm" (RFC 8188).
//
// The flow:
//
//  1. Generate a fresh P-256 keypair (the AS key).
//  2. ECDH between the AS private key and the subscription's `p256dh`
//     (the UA public key) produces a shared secret.
//  3. HKDF-Extract using `auth` as salt and the shared secret as IKM.
//     Then HKDF-Expand twice — once to derive the PRK, once to derive
//     the content-encryption key and nonce — using the info strings
//     prescribed by RFC 8291 §3.4.
//  4. Pad the plaintext to a fixed record size, AES-128-GCM seal.
//  5. Emit the RFC 8188 binary envelope: salt(16) || rs(4) || idlen(1)
//     || keyid(idlen) || ciphertext. For Web Push, idlen=65 and keyid
//     is the AS public key (uncompressed P-256 point).
//
// The caller posts the resulting bytes as the request body with
// `Content-Type: application/octet-stream` and `Content-Encoding:
// aes128gcm`. The VAPID JWT signing (in webpush.go) is unchanged.
//
// Implementation notes:
//
//   * We use the stdlib's crypto/ecdh which provides a constant-time
//     ECDH primitive and was added in Go 1.20.
//   * Record size 4096 covers any payload we'd realistically send
//     (booking notifications are <500 bytes). Larger payloads need
//     chunking which Web Push browsers don't reliably support anyway.
package webpush

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

const (
	recordSize = 4096
	keyIDLen   = 65 // uncompressed P-256 point: 0x04 || X(32) || Y(32)
)

// EncryptPayload returns the aes128gcm-encoded body for the given
// subscription's p256dh + auth and plaintext payload. Pass the result
// to PostEncrypted (or any request that sets Content-Encoding:
// aes128gcm). Callers MUST NOT reuse the output across subscriptions —
// the AS keypair is per-message.
func EncryptPayload(p256dhB64, authB64 string, plaintext []byte) ([]byte, error) {
	uaPubBytes, err := decodeURLOrStd(p256dhB64)
	if err != nil || len(uaPubBytes) != keyIDLen {
		return nil, fmt.Errorf("webpush: invalid p256dh (len=%d): %v", len(uaPubBytes), err)
	}
	authSecret, err := decodeURLOrStd(authBypadded(authB64))
	if err != nil || len(authSecret) < 8 {
		return nil, fmt.Errorf("webpush: invalid auth secret: %v", err)
	}

	curve := ecdh.P256()
	uaPub, err := curve.NewPublicKey(uaPubBytes)
	if err != nil {
		return nil, fmt.Errorf("webpush: p256dh parse: %w", err)
	}
	asPriv, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	asPub := asPriv.PublicKey().Bytes()
	if len(asPub) != keyIDLen {
		return nil, fmt.Errorf("webpush: AS pub len %d", len(asPub))
	}

	shared, err := asPriv.ECDH(uaPub)
	if err != nil {
		return nil, fmt.Errorf("webpush: ecdh: %w", err)
	}

	salt := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, salt); err != nil {
		return nil, err
	}

	// RFC 8291 §3.4 key-info: "WebPush: info\0" || UA_pub || AS_pub
	keyInfo := append([]byte("WebPush: info\x00"), uaPubBytes...)
	keyInfo = append(keyInfo, asPub...)
	prk := hkdfExtract(authSecret, shared)
	ikm := hkdfExpand(prk, keyInfo, 32)

	// RFC 8188 §2.2: content-encryption key & nonce derived from
	// HKDF(salt, IKM, ...).
	cekInfo := []byte("Content-Encoding: aes128gcm\x00")
	nonceInfo := []byte("Content-Encoding: nonce\x00")
	prk8188 := hkdfExtract(salt, ikm)
	cek := hkdfExpand(prk8188, cekInfo, 16)
	nonce := hkdfExpand(prk8188, nonceInfo, 12)

	// Pad to record size minus the AEAD tag and the trailing padding-
	// delimiter byte. Single-record encoding only.
	overhead := 16 + 1 // GCM tag + delimiter
	if len(plaintext)+overhead > recordSize {
		return nil, fmt.Errorf("webpush: plaintext too large for one record (%d > %d)",
			len(plaintext)+overhead, recordSize)
	}
	block, err := aes.NewCipher(cek)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	padLen := recordSize - len(plaintext) - overhead
	body := make([]byte, 0, len(plaintext)+1+padLen)
	body = append(body, plaintext...)
	body = append(body, 0x02) // last-record delimiter
	body = append(body, make([]byte, padLen)...)
	ct := gcm.Seal(nil, nonce, body, nil)

	// Envelope: salt(16) || rs(4) || idlen(1) || keyid(65) || ciphertext.
	out := make([]byte, 0, 16+4+1+keyIDLen+len(ct))
	out = append(out, salt...)
	rs := make([]byte, 4)
	binary.BigEndian.PutUint32(rs, recordSize)
	out = append(out, rs...)
	out = append(out, byte(keyIDLen))
	out = append(out, asPub...)
	out = append(out, ct...)
	return out, nil
}

// hkdfExtract + hkdfExpand implement RFC 5869 with SHA-256. The hash
// is hard-coded since every Web Push deployment uses SHA-256 — keeping
// the surface flat avoids the awkward "pass a hash factory" signature.
func hkdfExtract(salt, ikm []byte) []byte {
	mac := hmac.New(sha256.New, salt)
	mac.Write(ikm)
	return mac.Sum(nil)
}

func hkdfExpand(prk, info []byte, length int) []byte {
	out := []byte{}
	prev := []byte{}
	counter := byte(1)
	for len(out) < length {
		mac := hmac.New(sha256.New, prk)
		mac.Write(prev)
		mac.Write(info)
		mac.Write([]byte{counter})
		prev = mac.Sum(nil)
		out = append(out, prev...)
		counter++
	}
	return out[:length]
}

// decodeURLOrStd tries URL-safe base64 first, then standard. Push
// subscriptions from different browsers use slightly different forms.
func decodeURLOrStd(s string) ([]byte, error) {
	if s == "" {
		return nil, errors.New("empty")
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.URLEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(s)
}

// authBypadded normalises Chrome's quirk: the `auth` secret is
// 16 raw bytes but is sometimes emitted as base64url without padding.
// Tail-padding it lets the URLEncoding decoder accept it.
func authBypadded(s string) string {
	if pad := len(s) % 4; pad != 0 {
		return s + ""[:0] + paddingFor(4-pad)
	}
	return s
}

func paddingFor(n int) string {
	switch n {
	case 1:
		return "="
	case 2:
		return "=="
	case 3:
		return "==="
	}
	return ""
}
