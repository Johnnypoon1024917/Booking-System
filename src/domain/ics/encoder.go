// Package ics generates RFC 5545 (iCalendar) files for booking notifications.
//
// The output is suitable as a calendar attachment in email notifications so
// that recipients (Outlook, Gmail, Apple Calendar, etc.) can add or update
// the booking in their personal calendar with a single click. Updates are
// supported via SEQUENCE bumps; cancellations via METHOD:CANCEL.
package ics

import (
	"crypto/sha1"
	"fmt"
	"strings"
	"time"
)

// Method represents the iCalendar METHOD property.
type Method string

const (
	MethodRequest Method = "REQUEST"
	MethodCancel  Method = "CANCEL"
	MethodPublish Method = "PUBLISH"
)

// Event captures the data needed to render a single VEVENT.
//
// UID must be stable across updates so calendar clients merge rather than
// duplicate. The recommended pattern is "<booking-id>@<tenant-domain>".
type Event struct {
	UID         string
	Sequence    int
	Summary     string
	Description string
	Location    string
	Start       time.Time
	End         time.Time
	Organizer   Attendee
	Attendees   []Attendee
	URL         string
	Method      Method
}

// Attendee is one calendar participant.
type Attendee struct {
	Name  string
	Email string
}

// ProductID identifies the system that produced the calendar object. Per
// RFC 5545 §3.7.3 this should be a globally unique string under the producer's
// control. Tenants can override via TenantID below.
const ProductID = "-//FSD MRBS Platform//Booking Engine 1.0//EN"

// EncodeFeed renders a complete iCalendar document containing multiple
// events under METHOD:PUBLISH. This is the form calendar clients expect
// for a subscribable feed (Apple Calendar, Outlook "Subscribed
// Calendars", Google "Add by URL"). The feed should be served at a
// stable URL; clients re-fetch periodically.
func EncodeFeed(name string, events []Event) []byte {
	var b strings.Builder
	w := writer{b: &b}

	w.line("BEGIN:VCALENDAR")
	w.line("VERSION:2.0")
	w.line("PRODID:" + ProductID)
	w.line("CALSCALE:GREGORIAN")
	w.line("METHOD:PUBLISH")
	if name != "" {
		w.kv("X-WR-CALNAME", name)
		w.kv("X-WR-CALDESC", "FSD MRBS bookings")
	}
	for _, ev := range events {
		if ev.UID == "" {
			ev.UID = fingerprint(ev)
		}
		w.line("BEGIN:VEVENT")
		w.line("UID:" + ev.UID)
		w.line("SEQUENCE:" + fmt.Sprintf("%d", ev.Sequence))
		w.line("DTSTAMP:" + utc(time.Now()))
		w.line("DTSTART:" + utc(ev.Start))
		w.line("DTEND:" + utc(ev.End))
		w.kv("SUMMARY", ev.Summary)
		if ev.Description != "" {
			w.kv("DESCRIPTION", ev.Description)
		}
		if ev.Location != "" {
			w.kv("LOCATION", ev.Location)
		}
		if ev.URL != "" {
			w.kv("URL", ev.URL)
		}
		w.line("STATUS:CONFIRMED")
		w.line("TRANSP:OPAQUE")
		w.line("END:VEVENT")
	}
	w.line("END:VCALENDAR")
	return []byte(b.String())
}

// Encode renders a complete iCalendar document. The returned bytes are
// CRLF-terminated as required by RFC 5545 §3.1.
func Encode(ev Event) []byte {
	if ev.Method == "" {
		ev.Method = MethodRequest
	}
	if ev.UID == "" {
		ev.UID = fingerprint(ev)
	}

	var b strings.Builder
	w := writer{b: &b}

	w.line("BEGIN:VCALENDAR")
	w.line("VERSION:2.0")
	w.line("PRODID:" + ProductID)
	w.line("CALSCALE:GREGORIAN")
	w.line("METHOD:" + string(ev.Method))
	w.line("BEGIN:VEVENT")
	w.line("UID:" + ev.UID)
	w.line("SEQUENCE:" + fmt.Sprintf("%d", ev.Sequence))
	w.line("DTSTAMP:" + utc(time.Now()))
	w.line("DTSTART:" + utc(ev.Start))
	w.line("DTEND:" + utc(ev.End))
	w.kv("SUMMARY", ev.Summary)
	if ev.Description != "" {
		w.kv("DESCRIPTION", ev.Description)
	}
	if ev.Location != "" {
		w.kv("LOCATION", ev.Location)
	}
	if ev.URL != "" {
		w.kv("URL", ev.URL)
	}
	if ev.Organizer.Email != "" {
		w.line("ORGANIZER;CN=" + escape(ev.Organizer.Name) + ":mailto:" + ev.Organizer.Email)
	}
	for _, att := range ev.Attendees {
		w.line("ATTENDEE;CN=" + escape(att.Name) + ";RSVP=TRUE:mailto:" + att.Email)
	}
	if ev.Method == MethodCancel {
		w.line("STATUS:CANCELLED")
	} else {
		w.line("STATUS:CONFIRMED")
	}
	w.line("TRANSP:OPAQUE")
	w.line("END:VEVENT")
	w.line("END:VCALENDAR")
	return []byte(b.String())
}

// fingerprint produces a deterministic UID when none is supplied.
func fingerprint(ev Event) string {
	h := sha1.New()
	fmt.Fprintf(h, "%s|%s|%s|%s", ev.Summary, ev.Start.Format(time.RFC3339), ev.End.Format(time.RFC3339), ev.Location)
	return fmt.Sprintf("%x@fsd-mrbs", h.Sum(nil))
}

func utc(t time.Time) string {
	return t.UTC().Format("20060102T150405Z")
}

// escape applies RFC 5545 §3.3.11 text escaping.
func escape(s string) string {
	r := strings.NewReplacer(
		`\`, `\\`,
		";", `\;`,
		",", `\,`,
		"\n", `\n`,
		"\r", "",
	)
	return r.Replace(s)
}

type writer struct{ b *strings.Builder }

func (w writer) line(s string) {
	w.b.WriteString(fold(s))
	w.b.WriteString("\r\n")
}

func (w writer) kv(key, val string) {
	w.line(key + ":" + escape(val))
}

// fold applies RFC 5545 §3.1 line folding: split lines longer than 75 octets
// at any character boundary, prefixing continuations with a single space.
func fold(s string) string {
	const limit = 75
	if len(s) <= limit {
		return s
	}
	var out strings.Builder
	for i := 0; i < len(s); i += limit {
		if i > 0 {
			out.WriteString("\r\n ")
		}
		end := i + limit
		if end > len(s) {
			end = len(s)
		}
		out.WriteString(s[i:end])
	}
	return out.String()
}
