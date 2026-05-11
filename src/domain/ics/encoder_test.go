package ics

import (
	"strings"
	"testing"
	"time"
)

func TestEncodeProducesValidVEVENT(t *testing.T) {
	start := time.Date(2026, 5, 9, 9, 0, 0, 0, time.UTC)
	out := string(Encode(Event{
		UID:         "abc-123@fsd-mrbs",
		Sequence:    0,
		Summary:     "Quarterly Briefing",
		Location:    "FSD HQ Boardroom",
		Description: "Quarterly ops; bring laptops",
		Start:       start,
		End:         start.Add(time.Hour),
		Organizer:   Attendee{Name: "Johnny Poon", Email: "j.poon@fsd.gov.hk"},
		Attendees: []Attendee{
			{Name: "Section Head", Email: "head@fsd.gov.hk"},
		},
	}))

	for _, must := range []string{
		"BEGIN:VCALENDAR", "END:VCALENDAR",
		"BEGIN:VEVENT", "END:VEVENT",
		"VERSION:2.0", "METHOD:REQUEST",
		"UID:abc-123@fsd-mrbs",
		"DTSTART:20260509T090000Z",
		"DTEND:20260509T100000Z",
		"SUMMARY:Quarterly Briefing",
		"ORGANIZER;CN=Johnny Poon:mailto:j.poon@fsd.gov.hk",
		"ATTENDEE;CN=Section Head;RSVP=TRUE:mailto:head@fsd.gov.hk",
	} {
		if !strings.Contains(out, must) {
			t.Errorf("missing %q in output:\n%s", must, out)
		}
	}
	if !strings.HasSuffix(out, "\r\n") {
		t.Error("output must end with CRLF")
	}
}

func TestEncodeEscapesSpecialChars(t *testing.T) {
	out := string(Encode(Event{
		Summary:  `Risk; high, urgent\note`,
		Start:    time.Now(),
		End:      time.Now().Add(time.Hour),
	}))
	if !strings.Contains(out, `SUMMARY:Risk\; high\, urgent\\note`) {
		t.Errorf("escape failed:\n%s", out)
	}
}

func TestEncodeFoldsLongLines(t *testing.T) {
	long := strings.Repeat("A", 200)
	out := string(Encode(Event{
		Summary: long,
		Start:   time.Now(),
		End:     time.Now().Add(time.Hour),
	}))
	for _, line := range strings.Split(out, "\r\n") {
		if len(line) > 75 && !strings.HasPrefix(line, " ") {
			t.Errorf("unfolded line exceeds 75 octets: %q", line)
		}
	}
}

func TestCancelMethodMarksCancelled(t *testing.T) {
	out := string(Encode(Event{
		Method:  MethodCancel,
		Summary: "Cancelled meeting",
		Start:   time.Now(),
		End:     time.Now().Add(time.Hour),
	}))
	if !strings.Contains(out, "METHOD:CANCEL") || !strings.Contains(out, "STATUS:CANCELLED") {
		t.Errorf("cancel not represented: %s", out)
	}
}
