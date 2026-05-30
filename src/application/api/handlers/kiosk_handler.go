// Kiosk / room-display endpoint.
//
//	GET /api/v1/kiosk/<resourceId>/agenda
//
// Powers the Kiosk.vue view that runs on a tablet outside the meeting
// room. The endpoint is intentionally unauthenticated — anyone in the
// physical room can see what's booked there — but it leaks ONLY the
// minimal display projection: start, end, summary (resource name +
// "Booked" label, never the meeting subject or organiser), and a status
// hint. No emails, no notes, no meeting URLs.
//
// The current and next booking are surfaced separately so the kiosk can
// flip between "Available", "In use until X", and "Available — next at Y".
// Operators rate-limit this route at the edge if abuse becomes an issue.
package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type KioskHandler struct {
	pool *pgxpool.Pool
}

func NewKioskHandler(pool *pgxpool.Pool) *KioskHandler {
	return &KioskHandler{pool: pool}
}

type kioskEvent struct {
	Start   time.Time `json:"start"`
	End     time.Time `json:"end"`
	Summary string    `json:"summary"`
}

// Agenda returns today's events on the resource plus a "current/next"
// projection. Tenant scoping is implicit: the resource id is a UUID and
// we look it up once to confirm it exists; the rest of the query keys
// off resource_id so cross-tenant leakage is impossible.
func (h *KioskHandler) Agenda(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v1/kiosk/"), "/agenda")
	id = strings.Trim(id, "/")
	if id == "" {
		http.Error(w, "resource id required", http.StatusBadRequest)
		return
	}

	var resName, resLoc string
	if err := h.pool.QueryRow(r.Context(),
		`SELECT COALESCE(name,''), COALESCE(location,'') FROM resources WHERE id = $1`,
		id).Scan(&resName, &resLoc); err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	// Query today's confirmed bookings only. Pending and Cancelled are
	// suppressed so the kiosk display is never misleading.
	rows, err := h.pool.Query(r.Context(), `
SELECT start_time, end_time
FROM bookings
WHERE resource_id = $1
  AND status IN ('Confirmed', 'Checked In')
  AND start_time::date = CURRENT_DATE
ORDER BY start_time ASC`, id)
	if err != nil {
		http.Error(w, "agenda unavailable", http.StatusServiceUnavailable)
		return
	}
	defer rows.Close()

	now := time.Now()
	var (
		events  []kioskEvent
		current *kioskEvent
		next    *kioskEvent
	)
	for rows.Next() {
		var ev kioskEvent
		if err := rows.Scan(&ev.Start, &ev.End); err != nil {
			continue
		}
		// Display label is the room name plus a neutral "Booked" tag so
		// the kiosk never reveals the meeting subject to passers-by.
		ev.Summary = resName + " — Booked"
		events = append(events, ev)
		if current == nil && !now.Before(ev.Start) && now.Before(ev.End) {
			tmp := ev
			current = &tmp
		} else if next == nil && now.Before(ev.Start) {
			tmp := ev
			next = &tmp
		}
	}

	state := "free"
	if current != nil {
		state = "in-use"
	}
	// Cache for 15 seconds so a polling kiosk doesn't hammer the DB; the
	// SPA polls every 30s, so a stale window of one tick is acceptable.
	w.Header().Set("Cache-Control", "public, max-age=15")
	writeJSON(w, http.StatusOK, map[string]any{
		"resource_id":   id,
		"resource_name": resName,
		"resource_loc":  resLoc,
		"state":         state,
		"current":       current,
		"next":          next,
		"events":        events,
		"as_of":         now.UTC(),
	})
}
