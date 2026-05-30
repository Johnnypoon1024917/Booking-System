package rrule

import (
	"testing"
	"time"
)

func mustParse(t *testing.T, s string) Rule {
	t.Helper()
	r, err := Parse(s)
	if err != nil {
		t.Fatalf("parse %q: %v", s, err)
	}
	return r
}

func TestParse_Daily(t *testing.T) {
	r := mustParse(t, "FREQ=DAILY;COUNT=3")
	if r.Freq != FreqDaily || r.Count != 3 || r.Interval != 1 {
		t.Fatalf("unexpected parse: %+v", r)
	}
}

func TestParse_WeeklyByDay(t *testing.T) {
	r := mustParse(t, "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260601T000000Z")
	if r.Freq != FreqWeekly || len(r.ByDay) != 3 {
		t.Fatalf("unexpected parse: %+v", r)
	}
	if r.Until.IsZero() {
		t.Fatal("UNTIL not parsed")
	}
}

func TestParse_Errors(t *testing.T) {
	cases := []string{"", "FOO=BAR", "FREQ=NONSENSE", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;COUNT=3;UNTIL=20260101T000000Z"}
	for _, c := range cases {
		if _, err := Parse(c); err == nil {
			t.Errorf("expected error for %q", c)
		}
	}
}

func TestExpand_DailyCount(t *testing.T) {
	r := mustParse(t, "FREQ=DAILY;COUNT=5")
	start := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	occs, err := r.Expand(start, end)
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	if len(occs) != 5 {
		t.Fatalf("want 5 occurrences, got %d", len(occs))
	}
	for i, o := range occs {
		want := start.AddDate(0, 0, i)
		if !o.Start.Equal(want) {
			t.Errorf("occ %d: want %v, got %v", i, want, o.Start)
		}
		if o.End.Sub(o.Start) != time.Hour {
			t.Errorf("occ %d: duration drift", i)
		}
	}
}

func TestExpand_WeeklyByDay(t *testing.T) {
	r := mustParse(t, "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6")
	// 2026-06-01 is a Monday.
	start := time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC)
	end := start.Add(30 * time.Minute)
	occs, err := r.Expand(start, end)
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	if len(occs) != 6 {
		t.Fatalf("want 6 occurrences, got %d: %+v", len(occs), occs)
	}
	wantDays := []int{1, 3, 5, 8, 10, 12} // Mon, Wed, Fri × 2 weeks
	for i, want := range wantDays {
		if occs[i].Start.Day() != want {
			t.Errorf("occ %d: want day %d, got %d", i, want, occs[i].Start.Day())
		}
	}
}

func TestExpand_Cap(t *testing.T) {
	r := mustParse(t, "FREQ=DAILY") // no COUNT, no UNTIL
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	occs, err := r.Expand(start, start.Add(time.Hour))
	if err != nil {
		t.Fatalf("expand: %v", err)
	}
	if len(occs) != MaxOccurrences {
		t.Fatalf("want %d occurrences (cap), got %d", MaxOccurrences, len(occs))
	}
}

func TestExpand_EXDATE(t *testing.T) {
	r := mustParse(t, "FREQ=DAILY;COUNT=5")
	start := time.Date(2026, 6, 1, 10, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	r.ExDates = []time.Time{start.AddDate(0, 0, 2)} // skip day 3
	occs, _ := r.Expand(start, end)
	if len(occs) != 4 {
		t.Fatalf("EXDATE: want 4 left, got %d", len(occs))
	}
	for _, o := range occs {
		if o.Start.Day() == 3 {
			t.Errorf("EXDATE day was not removed: %+v", o)
		}
	}
}

func TestExpand_MonthlyByMonthDay(t *testing.T) {
	r := mustParse(t, "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=3")
	start := time.Date(2026, 1, 5, 10, 0, 0, 0, time.UTC)
	occs, _ := r.Expand(start, start.Add(time.Hour))
	if len(occs) != 3 {
		t.Fatalf("want 3, got %d", len(occs))
	}
	for _, o := range occs {
		if o.Start.Day() != 15 {
			t.Errorf("want day 15, got %v", o.Start)
		}
	}
}

func TestRoundtrip_String(t *testing.T) {
	r := mustParse(t, "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10")
	r2 := mustParse(t, r.String())
	if r2.String() != r.String() {
		t.Fatalf("roundtrip mismatch: %q vs %q", r.String(), r2.String())
	}
}
