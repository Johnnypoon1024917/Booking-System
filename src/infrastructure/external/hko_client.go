// Package external integrates with Hong Kong-specific public services that
// turn this booking system into a localized product:
//
//   - hko_client.go        HKO weather warning feed → triggers exception flow
//   - govhk_holidays.go    gov.hk public-holiday ICS feed → auto-import
//
// Both are best-effort enrichments. The system continues to work without
// them; missing data is logged but never fails a booking.
package external

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// HKO publishes a JSON warning summary at this stable endpoint.
const hkoWarningURL = "https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en"

// WeatherSignal codes we react to. The HKO returns codes like "TC8NE",
// "TC10", "WRAINB" (Black Rainstorm). We collapse to a shape useful for
// the exception workflow.
type WeatherSignal struct {
	Code        string    // "T1" / "T3" / "T8" / "T10" / "BLACK_RAIN" / "RED_RAIN" / "AMBER_RAIN"
	Severity    int       // 1 (mild) … 10 (extreme)
	Description string
	IssuedAt    time.Time
}

// HKOClient queries the HKO warnings API.
type HKOClient struct {
	http *http.Client
}

func NewHKOClient(timeout time.Duration) *HKOClient {
	if timeout == 0 {
		timeout = 8 * time.Second
	}
	return &HKOClient{http: &http.Client{Timeout: timeout}}
}

// CurrentSignals fetches the active weather signals. The HKO response
// shape is a flat object whose keys are warning identifiers; we project
// only the ones we care about for booking exceptions.
//
// Reference response keys: WTCSGNL (typhoon), WRAIN (rainstorm).
func (c *HKOClient) CurrentSignals(ctx context.Context) ([]WeatherSignal, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hkoWarningURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("hko: unexpected status %d", resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// Decode the heterogeneous map then extract the keys we care about.
	var raw map[string]struct {
		Name       string `json:"name"`
		Code       string `json:"code"`
		Type       string `json:"type"`
		ActionCode string `json:"actionCode"`
		IssueTime  string `json:"issueTime"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	var out []WeatherSignal
	for _, v := range raw {
		sig, ok := classify(v.Code, v.Name)
		if !ok {
			continue
		}
		issued, _ := time.Parse(time.RFC3339, v.IssueTime)
		sig.IssuedAt = issued
		out = append(out, sig)
	}
	return out, nil
}

// classify converts an HKO warning code to our internal taxonomy.
// Returns (zero, false) for warnings we don't act on (e.g. fire danger).
func classify(code, name string) (WeatherSignal, bool) {
	c := strings.ToUpper(code)
	n := strings.ToUpper(name)
	switch {
	case strings.Contains(c, "TC10"):
		return WeatherSignal{Code: "T10", Severity: 10, Description: name}, true
	case strings.Contains(c, "TC9"):
		return WeatherSignal{Code: "T9", Severity: 9, Description: name}, true
	case strings.Contains(c, "TC8"):
		return WeatherSignal{Code: "T8", Severity: 8, Description: name}, true
	case strings.Contains(c, "TC3"):
		return WeatherSignal{Code: "T3", Severity: 3, Description: name}, true
	case strings.Contains(c, "TC1"):
		return WeatherSignal{Code: "T1", Severity: 1, Description: name}, true
	case c == "WRAINB" || strings.Contains(n, "BLACK"):
		return WeatherSignal{Code: "BLACK_RAIN", Severity: 9, Description: name}, true
	case c == "WRAINR" || strings.Contains(n, "RED"):
		return WeatherSignal{Code: "RED_RAIN", Severity: 7, Description: name}, true
	case c == "WRAINA" || strings.Contains(n, "AMBER"):
		return WeatherSignal{Code: "AMBER_RAIN", Severity: 4, Description: name}, true
	}
	return WeatherSignal{}, false
}

// SuspendsBookings reports whether a signal is severe enough that no-show
// penalties should be auto-suspended (T8+, Black Rain).
func (s WeatherSignal) SuspendsBookings() bool {
	return s.Severity >= 8
}
