// Package safehttp provides HTTP plumbing hardened against SSRF.
//
// ValidateExternalURL is used at admin-input time to reject obviously
// internal URLs before they are persisted. SafeTransport is used at
// dial time to defeat DNS-rebinding: it re-checks every resolved
// address against the same allow rules before the TCP connect happens,
// so a hostname that resolved to a public IP at validation time but
// flips to 169.254.169.254 at dispatch time is still refused.
package safehttp

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// NewExternalClient returns an http.Client suitable for calling
// third-party APIs (Microsoft Graph, gov.hk, HKO, etc.). Unlike
// NewSafeClient, it does NOT block private IPs — those endpoints are
// public — but it DOES pin TLS to 1.2+ and a FIPS-aligned cipher list,
// which the Go default transport leaves unspecified. Use this for every
// outbound integration call that touches a credential or PII.
func NewExternalClient(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, Transport: HardenedTransport()}
}

// HardenedTransport returns the *http.Transport used by NewExternalClient.
// Exposed so callers that need to add their own customisation (e.g. a
// proxy URL) can layer on top without losing the TLS pinning.
func HardenedTransport() *http.Transport {
	return &http.Transport{
		TLSClientConfig: &tls.Config{
			MinVersion: tls.VersionTLS12,
			CipherSuites: []uint16{
				// TLS 1.3 ciphers are negotiated automatically; the list
				// below only constrains TLS 1.2.
				tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
				tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
				tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
				tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
				tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			},
			CurvePreferences: []tls.CurveID{tls.X25519, tls.CurveP256, tls.CurveP384},
		},
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          50,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}
}

// ValidateExternalURL enforces an SSRF allowlist on a user-supplied URL.
// Returns nil if the URL is safe for outbound traffic.
func ValidateExternalURL(raw string) error {
	if raw == "" {
		return errors.New("empty url")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	if u.Host == "" {
		return errors.New("missing host")
	}
	if u.User != nil {
		return errors.New("userinfo not allowed")
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" {
		if scheme == "http" && strings.EqualFold(os.Getenv("WEBHOOK_ALLOW_HTTP"), "true") {
			// permitted for local dev only
		} else {
			return errors.New("only https scheme is allowed")
		}
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("missing hostname")
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("dns lookup: %w", err)
	}
	if len(ips) == 0 {
		return errors.New("host did not resolve")
	}
	for _, ip := range ips {
		if err := RejectInternal(ip); err != nil {
			return err
		}
	}
	return nil
}

// RejectInternal returns an error if ip falls into a range that should
// never be reached from outbound webhook / integration traffic.
func RejectInternal(ip net.IP) error {
	if ip == nil {
		return errors.New("nil ip")
	}
	if ip.IsLoopback() {
		return errors.New("loopback addresses are not allowed")
	}
	if ip.IsUnspecified() {
		return errors.New("unspecified addresses are not allowed")
	}
	if ip.IsPrivate() {
		return errors.New("private addresses are not allowed")
	}
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return errors.New("link-local addresses are not allowed")
	}
	if ip.IsMulticast() {
		return errors.New("multicast addresses are not allowed")
	}
	if ip.IsInterfaceLocalMulticast() {
		return errors.New("interface-local addresses are not allowed")
	}
	for _, blocked := range []string{
		"169.254.169.254", // AWS / Azure / GCP IMDS
		"100.100.100.200", // Alibaba IMDS
		"fd00:ec2::254",   // AWS IPv6 IMDS
	} {
		if ip.Equal(net.ParseIP(blocked)) {
			return fmt.Errorf("metadata endpoint %s is not allowed", blocked)
		}
	}
	return nil
}

// NewSafeClient returns an http.Client whose dialer rejects internal,
// loopback, link-local, and metadata addresses at TCP-connect time —
// closing the DNS-rebinding gap that a one-shot allowlist check leaves.
// It also pins TLS 1.2+ (same baseline as NewExternalClient).
func NewSafeClient(timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := HardenedTransport()
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(addr)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			if err := RejectInternal(ip.IP); err != nil {
				return nil, fmt.Errorf("ssrf: %w", err)
			}
		}
		// Reconnect using the first allowed IP directly so a racing
		// resolver does not slip a different result through.
		return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}
	return &http.Client{Timeout: timeout, Transport: transport}
}
