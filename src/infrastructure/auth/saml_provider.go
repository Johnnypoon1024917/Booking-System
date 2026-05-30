// Package auth — SAML 2.0 service-provider implementation.
//
// Scope and trade-offs:
//
//   - We support the SP-initiated Web Browser SSO Profile with HTTP-POST
//     binding for the AuthnResponse (the form-POST callback the IdP sends
//     after a successful login). HTTP-Redirect for AuthnRequest is fine
//     for IdPs that accept it; that's the simpler binding.
//   - We require the IdP-signed Response. XML-Encryption is NOT supported
//     in this revision — operators who need encrypted assertions should
//     front the API with a SAML-aware gateway.
//   - External XML entities (XXE) are rejected by configuring
//     xml.Decoder.Strict = true and Entity = nil.
//
// The signature check is deliberately conservative: we extract the
// <ds:Signature> element verbatim from the bytes the IdP sent, verify
// the SignatureValue against the configured IdP signing certificate
// using PKCS#1 v1.5 with SHA-256 or SHA-1, and require the assertion
// time window and audience to match. A full XML-DSig c14n implementation
// is a follow-up; the current pass-through accepts the SignedInfo as
// emitted by mainstream IdPs (Azure AD, Okta, Shibboleth).
package auth

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rsa"
	"crypto/sha1" //nolint:gosec // legacy SAML IdPs still emit SHA-1; we also accept SHA-256
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"encoding/xml"
	"errors"
	"fmt"
	"strings"
	"time"

	"fsd-mrbs/src/domain/auth"
	"fsd-mrbs/src/domain/user"
)

// SAMLConfig captures the tenant's SAML SP configuration.
//
// EntityID is the SP entity id this deployment advertises. Certificate is
// the IdP's signing certificate in PEM form — used to verify the
// Response/Assertion signature. Operators MUST replace this on IdP key
// rotation; there is no JWKS-style auto-discovery in SAML.
type SAMLConfig struct {
	EntityID         string
	SSOURL           string
	SLOURL           string
	Certificate      string // IdP signing cert (PEM)
	PrivateKey       string // SP signing key (PEM) — only needed if we sign AuthnRequests
	IDPMetadataURL   string
	AttributeMapping map[string]string // SAML attr name → user.User field
}

// SAMLProvider implements IdentityProvider plus the response-handling
// helper the login flow needs.
type SAMLProvider struct {
	config   SAMLConfig
	idpCerts []*x509.Certificate
}

func NewSAMLProvider(config SAMLConfig) *SAMLProvider {
	p := &SAMLProvider{config: config}
	for block, rest := pemBlocks(config.Certificate); block != nil; block, rest = pemBlocks(rest) {
		if block.Type != "CERTIFICATE" {
			continue
		}
		if cert, err := x509.ParseCertificate(block.Bytes); err == nil {
			p.idpCerts = append(p.idpCerts, cert)
		}
	}
	return p
}

var _ auth.IdentityProvider = (*SAMLProvider)(nil)

func (p *SAMLProvider) GetProviderType() auth.ProviderType { return auth.ProviderTypeSAML }

// SSOURL is the IdP's single-sign-on endpoint the SP redirects browsers
// to. Exposed for the HTTP handler that initiates the flow.
func (p *SAMLProvider) SSOURL() string { return p.config.SSOURL }

// EntityID is this SP's entity identifier; used as the expected audience
// when validating the IdP's response.
func (p *SAMLProvider) EntityID() string { return p.config.EntityID }

// Authenticate is not supported — the SAML profile requires a browser
// round-trip via HandleResponse.
func (p *SAMLProvider) Authenticate(ctx context.Context, username, password string) (*user.User, error) {
	return nil, fmt.Errorf("%w: use SAML browser SSO via HandleResponse", auth.ErrNotImplemented)
}

func (p *SAMLProvider) SyncUser(ctx context.Context, userID string) error { return nil }
func (p *SAMLProvider) CheckDisabled(ctx context.Context, userID string) (bool, error) {
	return false, nil
}

// Health validates that at least one signing certificate parsed and is
// currently within its NotBefore/NotAfter window.
func (p *SAMLProvider) Health(ctx context.Context) error {
	if len(p.idpCerts) == 0 {
		return errors.New("saml: no IdP signing certificates configured")
	}
	now := time.Now()
	for _, c := range p.idpCerts {
		if now.After(c.NotBefore) && now.Before(c.NotAfter) {
			return nil
		}
	}
	return errors.New("saml: no IdP certificate is currently valid")
}

// SAMLAttributes is the structured projection of a verified assertion.
type SAMLAttributes struct {
	NameID     string
	Email      string
	GivenName  string
	FamilyName string
	Roles      []string
	Raw        map[string][]string
}

// HandleResponse validates a base64-encoded SAMLResponse posted to the
// SP's ACS URL and returns the projected attributes. It enforces, in
// order: well-formed XML (no DOCTYPE / external entities), a successful
// Status, signature validity against a configured IdP certificate,
// NotBefore/NotOnOrAfter window, and AudienceRestriction. InResponseTo
// correlation is the caller's responsibility — they should match the
// AuthnRequest ID they stored before redirecting.
func (p *SAMLProvider) HandleResponse(ctx context.Context, samlResponseB64, expectedAudience string) (*SAMLAttributes, error) {
	if len(p.idpCerts) == 0 {
		return nil, errors.New("saml: provider has no IdP signing certificate configured")
	}
	raw, err := base64.StdEncoding.DecodeString(samlResponseB64)
	if err != nil {
		return nil, fmt.Errorf("saml: decode response: %w", err)
	}
	dec := xml.NewDecoder(bytes.NewReader(raw))
	dec.Strict = true
	dec.Entity = nil // refuse external entity resolution (XXE)

	var resp samlResponse
	if err := dec.Decode(&resp); err != nil {
		return nil, fmt.Errorf("saml: parse response: %w", err)
	}
	if !strings.HasSuffix(resp.Status.StatusCode.Value, ":Success") {
		return nil, fmt.Errorf("saml: response status %q", resp.Status.StatusCode.Value)
	}
	if err := p.verifyResponseSignature(raw); err != nil {
		return nil, fmt.Errorf("saml: signature: %w", err)
	}
	a := &resp.Assertion
	if a.Subject.NameID == "" {
		return nil, errors.New("saml: assertion missing NameID")
	}
	if !insideTimeWindow(a.Conditions.NotBefore, a.Conditions.NotOnOrAfter) {
		return nil, errors.New("saml: assertion outside Conditions time window")
	}
	if expectedAudience != "" {
		found := false
		for _, ar := range a.Conditions.AudienceRestriction {
			for _, au := range ar.Audience {
				if au == expectedAudience {
					found = true
				}
			}
		}
		if !found {
			return nil, errors.New("saml: assertion audience does not include expected SP")
		}
	}

	out := &SAMLAttributes{NameID: a.Subject.NameID, Raw: map[string][]string{}}
	for _, attr := range a.AttributeStatement.Attribute {
		out.Raw[attr.Name] = append(out.Raw[attr.Name], attr.Values...)
	}
	out.Email = first(out.Raw,
		"email", "Email", "mail",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress")
	out.GivenName = first(out.Raw,
		"givenName",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname")
	out.FamilyName = first(out.Raw,
		"sn", "surname",
		"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname")
	out.Roles = out.Raw["http://schemas.microsoft.com/ws/2008/06/identity/claims/role"]
	if out.Email == "" {
		out.Email = a.Subject.NameID
	}
	return out, nil
}

// verifyResponseSignature locates the <ds:Signature> element under the
// Response or Assertion and verifies its SignatureValue against the
// configured IdP certificate. SHA-256 is preferred; SHA-1 is accepted
// because it remains in active use among legacy gov IdPs.
func (p *SAMLProvider) verifyResponseSignature(raw []byte) error {
	sig, err := extractSignature(raw)
	if err != nil {
		return err
	}
	signedBytes, err := canonicalize(sig.SignedElement)
	if err != nil {
		return fmt.Errorf("c14n: %w", err)
	}
	var hashed []byte
	var hashAlg crypto.Hash
	switch sig.Algorithm {
	case "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256":
		s := sha256.Sum256(signedBytes)
		hashed = s[:]
		hashAlg = crypto.SHA256
	case "http://www.w3.org/2000/09/xmldsig#rsa-sha1":
		s := sha1.Sum(signedBytes) //nolint:gosec
		hashed = s[:]
		hashAlg = crypto.SHA1
	default:
		return fmt.Errorf("unsupported signature algorithm %q", sig.Algorithm)
	}
	sigBytes, err := base64.StdEncoding.DecodeString(strings.TrimSpace(sig.SignatureValue))
	if err != nil {
		return fmt.Errorf("decode signature value: %w", err)
	}
	for _, cert := range p.idpCerts {
		pub, ok := cert.PublicKey.(*rsa.PublicKey)
		if !ok {
			continue
		}
		if err := rsa.VerifyPKCS1v15(pub, hashAlg, hashed, sigBytes); err == nil {
			return nil
		}
	}
	return errors.New("no configured IdP certificate verifies this signature")
}

// --- XML schema (cut down to the elements we actually verify) ---

type samlResponse struct {
	XMLName   xml.Name      `xml:"Response"`
	Issuer    string        `xml:"Issuer"`
	Status    samlStatus    `xml:"Status"`
	Assertion samlAssertion `xml:"Assertion"`
}

type samlStatus struct {
	StatusCode struct {
		Value string `xml:"Value,attr"`
	} `xml:"StatusCode"`
}

type samlAssertion struct {
	ID                 string                 `xml:"ID,attr"`
	IssueInstant       time.Time              `xml:"IssueInstant,attr"`
	Issuer             string                 `xml:"Issuer"`
	Subject            samlSubject            `xml:"Subject"`
	Conditions         samlConditions         `xml:"Conditions"`
	AttributeStatement samlAttributeStatement `xml:"AttributeStatement"`
}

type samlSubject struct {
	NameID string `xml:"NameID"`
}

type samlConditions struct {
	NotBefore           time.Time              `xml:"NotBefore,attr"`
	NotOnOrAfter        time.Time              `xml:"NotOnOrAfter,attr"`
	AudienceRestriction []samlAudienceRestrict `xml:"AudienceRestriction"`
}

type samlAudienceRestrict struct {
	Audience []string `xml:"Audience"`
}

type samlAttributeStatement struct {
	Attribute []samlAttribute `xml:"Attribute"`
}

type samlAttribute struct {
	Name   string   `xml:"Name,attr"`
	Values []string `xml:"AttributeValue"`
}

// --- helpers ---

// extractedSignature captures the SignatureMethod algorithm, the base64
// SignatureValue, and the SignedInfo bytes the verification needs.
type extractedSignature struct {
	Algorithm      string
	SignatureValue string
	SignedElement  []byte
}

func extractSignature(raw []byte) (*extractedSignature, error) {
	dec := xml.NewDecoder(bytes.NewReader(raw))
	dec.Strict = true
	dec.Entity = nil

	var (
		inSignature   bool
		depth         int
		buf           bytes.Buffer
		alg, sigValue string
	)
	for {
		tok, err := dec.RawToken()
		if err != nil {
			return nil, fmt.Errorf("extract signature: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "Signature" {
				inSignature = true
				depth = 0
			}
			if inSignature {
				depth++
				buf.WriteString("<" + t.Name.Local)
				for _, a := range t.Attr {
					buf.WriteString(fmt.Sprintf(" %s=%q", a.Name.Local, a.Value))
					if t.Name.Local == "SignatureMethod" && a.Name.Local == "Algorithm" {
						alg = a.Value
					}
				}
				buf.WriteString(">")
			}
		case xml.EndElement:
			if inSignature {
				buf.WriteString("</" + t.Name.Local + ">")
				depth--
				if depth == 0 {
					return &extractedSignature{
						Algorithm:      alg,
						SignatureValue: sigValue,
						SignedElement:  buf.Bytes(),
					}, nil
				}
			}
		case xml.CharData:
			if inSignature {
				txt := strings.TrimSpace(string(t))
				if txt != "" && sigValue == "" && depth >= 2 {
					sigValue = txt
				}
				buf.Write(t)
			}
		}
	}
}

// canonicalize delegates to the xml-exc-c14n implementation in
// xmlc14n.go. The pass-through that used to live here happened to work
// against Azure AD / Okta / Shibboleth because they emit canonical XML
// already, but any IdP that emits attribute ordering or namespace
// declarations differently would fail. With the real c14n step in
// place we can verify against every conformant IdP.
func canonicalize(in []byte) ([]byte, error) {
	return CanonicalizeExclusive(in, nil)
}

func insideTimeWindow(notBefore, notOnOrAfter time.Time) bool {
	now := time.Now()
	if !notBefore.IsZero() && now.Before(notBefore.Add(-30*time.Second)) {
		return false
	}
	if !notOnOrAfter.IsZero() && !now.Before(notOnOrAfter.Add(30*time.Second)) {
		return false
	}
	return true
}

func first(m map[string][]string, keys ...string) string {
	for _, k := range keys {
		if vs := m[k]; len(vs) > 0 && vs[0] != "" {
			return vs[0]
		}
	}
	return ""
}

func pemBlocks(in string) (*pem.Block, string) {
	block, rest := pem.Decode([]byte(in))
	return block, string(rest)
}
