// Package rrule implements a focused subset of RFC 5545 §3.3.10 RRULE
// recurrence rules — enough to round-trip with Outlook, Google Calendar,
// and Apple Calendar for the patterns booking systems actually use.
//
// Supported keys:
//
//	FREQ      DAILY | WEEKLY | MONTHLY | YEARLY
//	INTERVAL  positive integer; defaults to 1
//	COUNT     positive integer; mutually exclusive with UNTIL
//	UNTIL     UTC timestamp (YYYYMMDDTHHMMSSZ) or date (YYYYMMDD)
//	BYDAY     MO,TU,WE,TH,FR,SA,SU (weekly only here; monthly +1MO etc.
//	          is left for a follow-up — most calendars round-trip these
//	          to MONTHLY+BYMONTHDAY anyway)
//	BYMONTHDAY one day of the month (MONTHLY only)
//	WKST      not honoured — the parser accepts and ignores it
//
// EXDATE is a separate ICS property; we accept it as a sibling input on
// Expand so the caller's series store can persist it independently.
//
// The expander is deliberately bounded: every call clamps the result to
// MaxOccurrences so a malformed COUNT cannot fan out into thousands of
// rows. Callers that need more should ratchet the bound explicitly.
package rrule

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// MaxOccurrences is the safety bound enforced on every Expand call. The
// limit matches the existing 100-event cap on the recurring_series table.
const MaxOccurrences = 100

// Freq is one of the FREQ enumerants we accept.
type Freq string

const (
	FreqDaily   Freq = "DAILY"
	FreqWeekly  Freq = "WEEKLY"
	FreqMonthly Freq = "MONTHLY"
	FreqYearly  Freq = "YEARLY"
)

// Weekday matches RFC 5545 two-letter abbreviations (MO..SU).
type Weekday string

const (
	WdMon Weekday = "MO"
	WdTue Weekday = "TU"
	WdWed Weekday = "WE"
	WdThu Weekday = "TH"
	WdFri Weekday = "FR"
	WdSat Weekday = "SA"
	WdSun Weekday = "SU"
)

var weekdayToTime = map[Weekday]time.Weekday{
	WdSun: time.Sunday, WdMon: time.Monday, WdTue: time.Tuesday,
	WdWed: time.Wednesday, WdThu: time.Thursday, WdFri: time.Friday, WdSat: time.Saturday,
}

// Rule is the parsed representation of an RRULE plus optional EXDATEs.
// EXDATEs are not part of the RRULE itself in RFC 5545; they live next
// to it on the parent component. We accept them here so the expander
// can drop exceptions in a single pass.
type Rule struct {
	Freq       Freq
	Interval   int
	Count      int
	Until      time.Time // zero when COUNT is used instead
	ByDay      []Weekday // weekly only
	ByMonthDay int       // monthly only; 0 = use DTSTART's day
	ExDates    []time.Time
}

// Parse turns an RRULE string like "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12"
// into a Rule. Leading "RRULE:" is tolerated so callers can pass either
// the property or just its value.
func Parse(s string) (Rule, error) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "RRULE:")
	if s == "" {
		return Rule{}, errors.New("rrule: empty string")
	}
	r := Rule{Interval: 1}
	for _, part := range strings.Split(s, ";") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			return Rule{}, fmt.Errorf("rrule: malformed segment %q", part)
		}
		key := strings.ToUpper(strings.TrimSpace(kv[0]))
		val := strings.TrimSpace(kv[1])
		switch key {
		case "FREQ":
			switch Freq(strings.ToUpper(val)) {
			case FreqDaily, FreqWeekly, FreqMonthly, FreqYearly:
				r.Freq = Freq(strings.ToUpper(val))
			default:
				return Rule{}, fmt.Errorf("rrule: unsupported FREQ %q", val)
			}
		case "INTERVAL":
			n, err := strconv.Atoi(val)
			if err != nil || n <= 0 {
				return Rule{}, fmt.Errorf("rrule: INTERVAL must be positive int, got %q", val)
			}
			r.Interval = n
		case "COUNT":
			n, err := strconv.Atoi(val)
			if err != nil || n <= 0 {
				return Rule{}, fmt.Errorf("rrule: COUNT must be positive int, got %q", val)
			}
			r.Count = n
		case "UNTIL":
			t, err := parseUntil(val)
			if err != nil {
				return Rule{}, fmt.Errorf("rrule: UNTIL %q: %w", val, err)
			}
			r.Until = t
		case "BYDAY":
			for _, d := range strings.Split(val, ",") {
				wd := Weekday(strings.ToUpper(strings.TrimSpace(d)))
				if _, ok := weekdayToTime[wd]; !ok {
					return Rule{}, fmt.Errorf("rrule: unsupported BYDAY %q", d)
				}
				r.ByDay = append(r.ByDay, wd)
			}
		case "BYMONTHDAY":
			n, err := strconv.Atoi(val)
			if err != nil || n < 1 || n > 31 {
				return Rule{}, fmt.Errorf("rrule: BYMONTHDAY must be 1..31, got %q", val)
			}
			r.ByMonthDay = n
		case "WKST":
			// accepted and ignored — see package comment
		default:
			return Rule{}, fmt.Errorf("rrule: unsupported key %q", key)
		}
	}
	if r.Freq == "" {
		return Rule{}, errors.New("rrule: FREQ is required")
	}
	if r.Count > 0 && !r.Until.IsZero() {
		return Rule{}, errors.New("rrule: COUNT and UNTIL are mutually exclusive")
	}
	return r, nil
}

// String renders the Rule back to RFC 5545 RRULE form. Round-trips
// preserve the original semantics, not necessarily byte equality.
func (r Rule) String() string {
	var parts []string
	parts = append(parts, "FREQ="+string(r.Freq))
	if r.Interval > 1 {
		parts = append(parts, fmt.Sprintf("INTERVAL=%d", r.Interval))
	}
	if r.Count > 0 {
		parts = append(parts, fmt.Sprintf("COUNT=%d", r.Count))
	}
	if !r.Until.IsZero() {
		parts = append(parts, "UNTIL="+r.Until.UTC().Format("20060102T150405Z"))
	}
	if len(r.ByDay) > 0 {
		days := make([]string, len(r.ByDay))
		for i, d := range r.ByDay {
			days[i] = string(d)
		}
		parts = append(parts, "BYDAY="+strings.Join(days, ","))
	}
	if r.ByMonthDay > 0 {
		parts = append(parts, fmt.Sprintf("BYMONTHDAY=%d", r.ByMonthDay))
	}
	return strings.Join(parts, ";")
}

// Expand returns the concrete (start, end) windows for the series given a
// DTSTART/DTEND first occurrence. The function never emits more than
// MaxOccurrences entries and skips any candidate whose start matches an
// EXDATE entry (to-the-second). When neither COUNT nor UNTIL is set, the
// expander uses MaxOccurrences as the implicit bound.
func (r Rule) Expand(dtStart, dtEnd time.Time) ([]Occurrence, error) {
	if !dtEnd.After(dtStart) {
		return nil, errors.New("rrule: DTEND must be after DTSTART")
	}
	step := r.Interval
	if step <= 0 {
		step = 1
	}
	limit := r.Count
	if limit <= 0 {
		limit = MaxOccurrences
	}
	if limit > MaxOccurrences {
		limit = MaxOccurrences
	}
	duration := dtEnd.Sub(dtStart)
	out := make([]Occurrence, 0, limit)

	switch r.Freq {
	case FreqDaily:
		for cur := dtStart; len(out) < limit; cur = cur.AddDate(0, 0, step) {
			if !r.Until.IsZero() && cur.After(r.Until) {
				break
			}
			out = append(out, Occurrence{Start: cur, End: cur.Add(duration)})
		}
	case FreqWeekly:
		days := r.ByDay
		if len(days) == 0 {
			days = []Weekday{timeToWeekday(dtStart.Weekday())}
		}
		// Walk week by week; within each interval-week emit every BYDAY
		// that falls on or after dtStart. Order results chronologically.
		for week := 0; len(out) < limit; week += step {
			anchor := dtStart.AddDate(0, 0, 7*week)
			for _, d := range days {
				offset := int(weekdayToTime[d]) - int(anchor.Weekday())
				if offset < 0 {
					offset += 7
				}
				candidate := anchor.AddDate(0, 0, offset)
				if candidate.Before(dtStart) {
					continue
				}
				if !r.Until.IsZero() && candidate.After(r.Until) {
					return out, nil
				}
				out = append(out, Occurrence{Start: candidate, End: candidate.Add(duration)})
				if len(out) >= limit {
					break
				}
			}
		}
	case FreqMonthly:
		for i := 0; len(out) < limit; i += step {
			cur := dtStart.AddDate(0, i, 0)
			if r.ByMonthDay > 0 {
				cur = time.Date(cur.Year(), cur.Month(), r.ByMonthDay,
					dtStart.Hour(), dtStart.Minute(), dtStart.Second(), dtStart.Nanosecond(), dtStart.Location())
			}
			if !r.Until.IsZero() && cur.After(r.Until) {
				break
			}
			out = append(out, Occurrence{Start: cur, End: cur.Add(duration)})
		}
	case FreqYearly:
		for i := 0; len(out) < limit; i += step {
			cur := dtStart.AddDate(i, 0, 0)
			if !r.Until.IsZero() && cur.After(r.Until) {
				break
			}
			out = append(out, Occurrence{Start: cur, End: cur.Add(duration)})
		}
	default:
		return nil, fmt.Errorf("rrule: unsupported FREQ %q", r.Freq)
	}

	if len(r.ExDates) > 0 {
		out = filterExDates(out, r.ExDates)
	}
	return out, nil
}

// Occurrence is one expanded window.
type Occurrence struct {
	Start time.Time
	End   time.Time
}

func filterExDates(in []Occurrence, ex []time.Time) []Occurrence {
	skip := make(map[int64]struct{}, len(ex))
	for _, t := range ex {
		skip[t.Unix()] = struct{}{}
	}
	out := in[:0]
	for _, o := range in {
		if _, drop := skip[o.Start.Unix()]; drop {
			continue
		}
		out = append(out, o)
	}
	return out
}

func parseUntil(s string) (time.Time, error) {
	for _, layout := range []string{"20060102T150405Z", "20060102T150405", "20060102"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("not an RFC 5545 date/time")
}

func timeToWeekday(w time.Weekday) Weekday {
	for k, v := range weekdayToTime {
		if v == w {
			return k
		}
	}
	return WdMon
}
