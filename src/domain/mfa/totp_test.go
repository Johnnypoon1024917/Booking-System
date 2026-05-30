package mfa

import "testing"

func TestGenerateSecret_DistinctAndDecodable(t *testing.T) {
	a, err := GenerateSecret()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	b, err := GenerateSecret()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if a == b {
		t.Fatal("two GenerateSecret() calls returned the same value")
	}
	// Decodable as base32 (no padding).
	if _, err := Verify(a, "000000"); err != nil {
		t.Fatalf("Verify should accept a fresh secret as input; got error: %v", err)
	}
}

func TestVerify_RejectsBadShape(t *testing.T) {
	secret, _ := GenerateSecret()
	cases := []string{"", "abc", "1234567"}
	for _, c := range cases {
		ok, err := Verify(secret, c)
		if ok || err == nil {
			t.Errorf("Verify(%q) should reject malformed code", c)
		}
	}
}

func TestVerify_AcceptsCurrentStep(t *testing.T) {
	secret, err := GenerateSecret()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	// Compute the live code using the same internals — round-trip sanity check.
	key, err := decode(secret)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	code := generateCode(key, nowStep())
	ok, err := Verify(secret, code)
	if err != nil {
		t.Fatalf("verify err: %v", err)
	}
	if !ok {
		t.Fatal("Verify rejected a code generated from the same secret")
	}
}

func TestOtpauthURL_ContainsExpectedFields(t *testing.T) {
	u := OtpauthURL("FSD MRBS", "alice@example", "JBSWY3DPEHPK3PXP")
	want := []string{"otpauth://totp/", "secret=", "issuer=", "algorithm=SHA1", "digits=6", "period=30"}
	for _, w := range want {
		if !contains(u, w) {
			t.Errorf("OtpauthURL missing %q in %q", w, u)
		}
	}
}

// test-only helpers
func contains(s, sub string) bool { return len(s) >= len(sub) && indexOf(s, sub) >= 0 }
func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
