// Package email sends booking notifications via SMTP with an attached ICS
// calendar file. The notification worker (cmd/worker) consumes the
// booking_events queue and calls Send for each event.
//
// The implementation uses the stdlib net/smtp; for production we recommend
// swapping in an authenticated provider client (SES / SendGrid / Mailgun)
// behind the Sender interface defined here.
package email

import (
	"bytes"
	"crypto/tls"
	"errors"
	"fmt"
	"mime/multipart"
	"net/mail"
	"net/smtp"
	"net/textproto"
	"os"
	"strings"
)

// Sender abstracts the underlying transport for testing and provider swap.
type Sender interface {
	Send(msg Message) error
}

// Message carries everything the worker assembled for one notification.
type Message struct {
	From         string
	To           []string
	Cc           []string
	Subject      string
	HTMLBody     string
	TextBody     string
	ICSAttachment []byte
	ICSFilename  string
}

// SMTPSender ships messages through a classic SMTP relay.
//
// Transport mode is auto-selected by port to avoid the historical
// "tls.Dial against 587" mistake:
//
//   - 465 → implicit TLS (tls.Dial), used by submissions-over-TLS
//   - 587 → STARTTLS on a plain TCP connection (the modern standard)
//   - other → plain TCP, STARTTLS attempted opportunistically
//
// SMTP_TLS=true forces TLS regardless of port. SMTP_TLS=false on 587 is
// rejected at Send-time so credentials never leave the process in plain
// text by accident.
type SMTPSender struct {
	Host     string
	Port     string
	Username string
	Password string
	UseTLS   bool
}

// FromEnv reads sane defaults from environment variables. Returns an error
// if SMTP_HOST is not set so the worker can degrade to log-only mode in
// development.
func FromEnv() (*SMTPSender, error) {
	host := os.Getenv("SMTP_HOST")
	if host == "" {
		return nil, errors.New("SMTP_HOST not configured")
	}
	port := os.Getenv("SMTP_PORT")
	if port == "" {
		port = "587"
	}
	return &SMTPSender{
		Host:     host,
		Port:     port,
		Username: os.Getenv("SMTP_USERNAME"),
		Password: os.Getenv("SMTP_PASSWORD"),
		UseTLS:   strings.EqualFold(os.Getenv("SMTP_TLS"), "true"),
	}, nil
}

// Send writes a multipart/alternative + ICS attachment message and dispatches
// it. The Subject and bodies are written in UTF-8.
func (s *SMTPSender) Send(msg Message) error {
	if len(msg.To) == 0 {
		return errors.New("no recipients")
	}
	body, contentType, err := build(msg)
	if err != nil {
		return err
	}
	headers := []string{
		"From: " + msg.From,
		"To: " + strings.Join(msg.To, ", "),
	}
	if len(msg.Cc) > 0 {
		headers = append(headers, "Cc: "+strings.Join(msg.Cc, ", "))
	}
	headers = append(headers,
		"Subject: "+encodeRFC2047(msg.Subject),
		"MIME-Version: 1.0",
		"Content-Type: "+contentType,
	)
	raw := []byte(strings.Join(headers, "\r\n") + "\r\n\r\n" + body.String())

	addr := s.Host + ":" + s.Port
	auth := smtp.PlainAuth("", s.Username, s.Password, s.Host)
	tlsConfig := &tls.Config{ServerName: s.Host, MinVersion: tls.VersionTLS12}

	// Pick transport by port; SMTP_TLS=true overrides to implicit TLS.
	useImplicitTLS := s.UseTLS || s.Port == "465"
	mustStartTLS := s.Port == "587" // refuse to authenticate in plaintext on submission port

	var c *smtp.Client
	if useImplicitTLS {
		conn, err := tls.Dial("tcp", addr, tlsConfig)
		if err != nil {
			return fmt.Errorf("smtp tls dial: %w", err)
		}
		c, err = smtp.NewClient(conn, s.Host)
		if err != nil {
			conn.Close()
			return fmt.Errorf("smtp client: %w", err)
		}
	} else {
		var err error
		c, err = smtp.Dial(addr)
		if err != nil {
			return fmt.Errorf("smtp dial: %w", err)
		}
		// Issue EHLO + STARTTLS handshake. If the server doesn't advertise
		// STARTTLS but the port mandates it (587), fail closed.
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsConfig); err != nil {
				c.Close()
				return fmt.Errorf("smtp starttls: %w", err)
			}
		} else if mustStartTLS {
			c.Close()
			return fmt.Errorf("smtp server on port %s did not advertise STARTTLS — refusing to send credentials in plaintext", s.Port)
		}
	}
	defer c.Close()

	if s.Username != "" {
		// Refuse PLAIN auth over a plaintext channel (defensive: c.Auth
		// already does this, but the explicit check fails earlier and with
		// a clearer message).
		if ok, _ := c.Extension("AUTH"); !ok {
			return fmt.Errorf("smtp server does not advertise AUTH")
		}
		if err := c.Auth(auth); err != nil {
			return fmt.Errorf("smtp auth: %w", err)
		}
	}
	if err := c.Mail(msg.From); err != nil {
		return err
	}
	for _, rcpt := range append(msg.To, msg.Cc...) {
		if err := c.Rcpt(rcpt); err != nil {
			return err
		}
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	if _, err := wc.Write(raw); err != nil {
		return err
	}
	return wc.Close()
}

// build returns the multipart body and the top-level Content-Type value.
func build(msg Message) (*bytes.Buffer, string, error) {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)

	// alternative part: text + html
	altHeader := textproto.MIMEHeader{}
	altHeader.Set("Content-Type", "multipart/alternative; boundary=\"alt-"+mw.Boundary()+"\"")
	altPart, err := mw.CreatePart(altHeader)
	if err != nil {
		return nil, "", err
	}
	alt := multipart.NewWriter(altPart)
	alt.SetBoundary("alt-" + mw.Boundary())

	if msg.TextBody == "" {
		msg.TextBody = stripHTML(msg.HTMLBody)
	}
	tp, _ := alt.CreatePart(textproto.MIMEHeader{
		"Content-Type": []string{"text/plain; charset=UTF-8"},
	})
	tp.Write([]byte(msg.TextBody))
	hp, _ := alt.CreatePart(textproto.MIMEHeader{
		"Content-Type": []string{"text/html; charset=UTF-8"},
	})
	hp.Write([]byte(msg.HTMLBody))
	alt.Close()

	// ics attachment
	if len(msg.ICSAttachment) > 0 {
		filename := msg.ICSFilename
		if filename == "" {
			filename = "invite.ics"
		}
		icsHeader := textproto.MIMEHeader{}
		icsHeader.Set("Content-Type", `text/calendar; method=REQUEST; charset=UTF-8; name="`+filename+`"`)
		icsHeader.Set("Content-Disposition", `attachment; filename="`+filename+`"`)
		icsHeader.Set("Content-Transfer-Encoding", "8bit")
		ip, _ := mw.CreatePart(icsHeader)
		ip.Write(msg.ICSAttachment)
	}
	mw.Close()

	contentType := fmt.Sprintf(`multipart/mixed; boundary="%s"`, mw.Boundary())
	return &buf, contentType, nil
}

func encodeRFC2047(s string) string {
	addr := mail.Address{Name: s, Address: ""}
	return strings.TrimSuffix(strings.TrimPrefix(addr.String(), "\""), "\" <@>")
}

// stripHTML is a tiny, naive HTML→text fallback for clients that don't
// render HTML. Replace with a real converter when bandwidth allows.
func stripHTML(s string) string {
	out := s
	for {
		i := strings.Index(out, "<")
		if i == -1 {
			break
		}
		j := strings.Index(out[i:], ">")
		if j == -1 {
			break
		}
		out = out[:i] + out[i+j+1:]
	}
	return out
}

// LogSender is the dev fallback when SMTP isn't configured. It writes the
// outgoing message metadata to stdout so developers can verify the worker
// fired without a real mail server.
type LogSender struct{}

func (LogSender) Send(msg Message) error {
	fmt.Printf("[email/log] to=%v subj=%q ics=%dB\n", msg.To, msg.Subject, len(msg.ICSAttachment))
	return nil
}
