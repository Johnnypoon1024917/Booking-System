package external

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// gov.hk publishes the official HK public-holiday calendar at these stable
// URLs (per https://www.1823.gov.hk/common/ical/). We import nightly so
// admins don't have to maintain holidays manually.
const (
	govHKHolidayURLEn      = "https://www.1823.gov.hk/common/ical/en.ics"
	govHKHolidayURLZhHant  = "https://www.1823.gov.hk/common/ical/tc.ics"
	govHKHolidayURLZhHans  = "https://www.1823.gov.hk/common/ical/sc.ics"
)

// GovHKHoliday is one entry parsed from the gov.hk feed.
type GovHKHoliday struct {
	Date        time.Time
	Description string
}

// GovHKHolidayClient downloads and parses the public-holiday ICS feed.
type GovHKHolidayClient struct {
	http *http.Client
}

func NewGovHKHolidayClient(timeout time.Duration) *GovHKHolidayClient {
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	return &GovHKHolidayClient{http: &http.Client{Timeout: timeout}}
}

// Fetch returns the holidays in the requested locale (defaults to English).
// "zh-Hant" or "zh-Hans" pulls the Traditional / Simplified Chinese feed.
func (c *GovHKHolidayClient) Fetch(ctx context.Context, locale string) ([]GovHKHoliday, error) {
	url := govHKHolidayURLEn
	switch strings.ToLower(locale) {
	case "zh-hant", "tc", "zh_tw":
		url = govHKHolidayURLZhHant
	case "zh-hans", "sc", "zh_cn":
		url = govHKHolidayURLZhHans
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("gov.hk: status %d", resp.StatusCode)
	}
	return parseICSHolidays(resp.Body)
}

// ParseICSHolidaysReader is the exported entry point for the same parser,
// used by the admin holiday-upload handler so tenants can import a custom
// ICS file (not just the gov.hk feed).
func ParseICSHolidaysReader(r io.Reader) ([]GovHKHoliday, error) {
	return parseICSHolidays(r)
}

// parseICSHolidays does a minimal RFC 5545 parse: we only care about
// VEVENT blocks with DTSTART;VALUE=DATE (all-day events) and SUMMARY.
// Hand-rolled instead of importing a heavy library; the gov.hk feed is
// trivially simple and well-formed.
func parseICSHolidays(r io.Reader) ([]GovHKHoliday, error) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	var (
		out      []GovHKHoliday
		inEvent  bool
		current  GovHKHoliday
	)
	for scanner.Scan() {
		line := scanner.Text()
		// Unfold continuation lines (start with space/tab) — but each line
		// arrives separately, so we just trim leading whitespace; gov.hk
		// rarely folds the short fields we look at.
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") {
			continue
		}
		switch {
		case line == "BEGIN:VEVENT":
			inEvent = true
			current = GovHKHoliday{}
		case line == "END:VEVENT":
			if !current.Date.IsZero() {
				out = append(out, current)
			}
			inEvent = false
		case inEvent && strings.HasPrefix(line, "DTSTART"):
			// e.g. "DTSTART;VALUE=DATE:20260101"
			if idx := strings.LastIndex(line, ":"); idx > 0 {
				v := strings.TrimSpace(line[idx+1:])
				if t, err := time.Parse("20060102", v); err == nil {
					current.Date = t
				}
			}
		case inEvent && strings.HasPrefix(line, "SUMMARY"):
			if idx := strings.Index(line, ":"); idx > 0 {
				current.Description = unescapeICS(strings.TrimSpace(line[idx+1:]))
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func unescapeICS(s string) string {
	r := strings.NewReplacer(`\,`, ",", `\;`, ";", `\n`, "\n", `\\`, `\`)
	return r.Replace(s)
}
