// Subscribable iCal feed.
//
//	GET /api/v1/me/calendar/token    (authenticated) -> mint a feed token
//	GET /ical/<token>.ics             (unauthenticated) -> serve the feed
//
// Calendar clients (Apple Calendar, Outlook "Subscribed Calendars",
// Google "Add by URL") fetch the feed periodically and do not send
// Authorization headers, so the URL itself must carry the credential.
// We mint a long-lived HMAC token that encodes (tenant_id, user_id,
// expiry); the secret is the same JWT signing key, so revoking sessions
// also revokes feeds.
package handlers

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/ics"

	"github.com/jackc/pgx/v5/pgxpool"
)

// ICalFeedHandler issues and serves subscribable iCal URLs.
type ICalFeedHandler struct {
	pool      *pgxpool.Pool
	secret    []byte
	publicURL string // base URL the SPA prefixes the token with (e.g. "https://mrbs.example.com")
	tokenTTL  time.Duration
}

func NewICalFeedHandler(pool *pgxpool.Pool, secret []byte, publicURL string, ttl time.Duration) *ICalFeedHandler {
	if ttl <= 0 {
		ttl = 365 * 24 * time.Hour
	}
	return &ICalFeedHandler{pool: pool, secret: secret, publicURL: publicURL, tokenTTL: ttl}
}

// MintToken returns a feed URL the user can paste into their calendar
// client. Each call returns a fresh token; the previous one stays valid
// until expiry, so users can rotate without disrupting subscriptions.
func (h *ICalFeedHandler) MintToken(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	exp := time.Now().Add(h.tokenTTL).Unix()
	tok := signFeedToken(h.secret, tid.String(), uid, exp)
	feedURL := strings.TrimRight(h.publicURL, "/") + "/ical/" + tok + ".ics"
	writeJSON(w, http.StatusOK, map[string]any{
		"feed_url":   feedURL,
		"expires_at": time.Unix(exp, 0).UTC(),
	})
}

// Serve handles GET /ical/<token>.ics. It validates the token, looks up
// the user's upcoming bookings (90 days back, 365 days forward), and
// returns the iCalendar document. Errors are deliberately terse — we
// don't want calendar clients spamming the operator's inbox with
// detailed error fetches.
func (h *ICalFeedHandler) Serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/ical/")
	path = strings.TrimSuffix(path, ".ics")
	if path == "" {
		http.Error(w, "missing token", http.StatusBadRequest)
		return
	}
	tenantID, userID, ok := verifyFeedToken(h.secret, path)
	if !ok {
		http.Error(w, "invalid or expired feed token", http.StatusUnauthorized)
		return
	}

	rows, err := h.pool.Query(r.Context(), `
SELECT b.id, b.start_time, b.end_time, COALESCE(b.meeting_url,''), COALESCE(b.exception_notes,''),
       COALESCE(r.name,''), COALESCE(r.location,'')
FROM bookings b
LEFT JOIN resources r ON r.id = b.resource_id
WHERE b.tenant_id = $1 AND b.user_id = $2
  AND b.status IN ('Confirmed', 'Pending Approval', 'Checked In')
  AND b.end_time > NOW() - INTERVAL '90 days'
  AND b.start_time < NOW() + INTERVAL '365 days'
ORDER BY b.start_time ASC`, tenantID, userID)
	if err != nil {
		http.Error(w, "feed unavailable", http.StatusServiceUnavailable)
		return
	}
	defer rows.Close()

	var events []ics.Event
	for rows.Next() {
		var (
			id, meetingURL, notes, resName, resLoc string
			start, end                              time.Time
		)
		if err := rows.Scan(&id, &start, &end, &meetingURL, &notes, &resName, &resLoc); err != nil {
			continue
		}
		summary := resName
		if summary == "" {
			summary = "FSD booking"
		}
		events = append(events, ics.Event{
			UID:         id + "@fsd-mrbs",
			Summary:     summary,
			Description: notes,
			Location:    resLoc,
			Start:       start,
			End:         end,
			URL:         meetingURL,
			Method:      ics.MethodPublish,
		})
	}

	body := ics.EncodeFeed("FSD MRBS — My bookings", events)
	w.Header().Set("Content-Type", "text/calendar; charset=utf-8")
	w.Header().Set("Content-Disposition", `inline; filename="mrbs-bookings.ics"`)
	w.Header().Set("Cache-Control", "private, max-age=300")
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	_, _ = w.Write(body)
}

// signFeedToken returns base64url(payload) + "." + base64url(hmac).
// Payload format: tenantID|userID|expUnix. Compact enough to fit in a
// URL path segment without quoting.
func signFeedToken(secret []byte, tenantID, userID string, exp int64) string {
	payload := fmt.Sprintf("%s|%s|%d", tenantID, userID, exp)
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." +
		base64.RawURLEncoding.EncodeToString(sig)
}

func verifyFeedToken(secret []byte, token string) (tenantID, userID string, ok bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return "", "", false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", "", false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", "", false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return "", "", false
	}
	fields := strings.SplitN(string(payload), "|", 3)
	if len(fields) != 3 {
		return "", "", false
	}
	var exp int64
	if _, err := fmt.Sscanf(fields[2], "%d", &exp); err != nil {
		return "", "", false
	}
	if time.Now().Unix() > exp {
		return "", "", false
	}
	return fields[0], fields[1], true
}
