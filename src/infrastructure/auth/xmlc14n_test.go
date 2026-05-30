package auth

import (
	"strings"
	"testing"
)

// TestC14n_NormalisesAttributeOrder asserts that two byte-different but
// semantically equal SignedInfo blocks produce the same canonical form.
// This is the property that lets signature verification work across
// IdPs with quirky attribute ordering.
func TestC14n_NormalisesAttributeOrder(t *testing.T) {
	a := `<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="abc" version="1"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:SignedInfo>`
	b := `<ds:SignedInfo version="1" Id="abc" xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:CanonicalizationMethod Algorithm="http://www.w3.org/2001/10/xml-exc-c14n#"/></ds:SignedInfo>`
	ca, err := CanonicalizeExclusive([]byte(a), nil)
	if err != nil {
		t.Fatalf("a: %v", err)
	}
	cb, err := CanonicalizeExclusive([]byte(b), nil)
	if err != nil {
		t.Fatalf("b: %v", err)
	}
	if string(ca) != string(cb) {
		t.Fatalf("c14n divergence:\nA=%s\nB=%s", ca, cb)
	}
}

func TestC14n_EscapesAttribute(t *testing.T) {
	in := `<a xmlns="urn:x" v="a&amp;b&lt;c&#10;d"/>`
	out, err := CanonicalizeExclusive([]byte(in), nil)
	if err != nil {
		t.Fatalf("c14n: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, "&amp;") || !strings.Contains(s, "&lt;") || !strings.Contains(s, "&#xA;") {
		t.Fatalf("attribute escaping missing: %q", s)
	}
}

func TestC14n_DropsComments(t *testing.T) {
	in := `<a xmlns="urn:x"><!-- secret --><b>ok</b></a>`
	out, _ := CanonicalizeExclusive([]byte(in), nil)
	if strings.Contains(string(out), "secret") {
		t.Fatalf("comment was emitted: %s", out)
	}
}

func TestC14n_EmitsOnlyUsedNamespaces(t *testing.T) {
	// xmlns:unused is declared but no descendant uses it -> exclusive
	// canonicalisation drops it.
	in := `<a xmlns:used="urn:used" xmlns:unused="urn:unused"><used:b>x</used:b></a>`
	out, err := CanonicalizeExclusive([]byte(in), nil)
	if err != nil {
		t.Fatalf("c14n: %v", err)
	}
	s := string(out)
	if strings.Contains(s, "unused") {
		t.Fatalf("exclusive c14n should drop unused ns decl: %s", s)
	}
	if !strings.Contains(s, `xmlns:used="urn:used"`) {
		t.Fatalf("used ns decl missing: %s", s)
	}
}
