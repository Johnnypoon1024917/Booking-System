// Federated free/busy endpoint.
//
// Returns busy intervals for one or more PRINCIPALS — typically a user
// email or a resource id — within a time window, with no PII. Modelled
// on Microsoft Graph's /me/calendar/getSchedule and Google Calendar's
// /freeBusy.query: the same wire shape, so the SPA's scheduling
// assistant and any external connector (Power Automate, Zapier, an
// Outlook add-in) can drop us in.
//
//	POST /api/v1/freebusy
//	body: {
//	  "subjects":   ["alice@fsd.gov.hk", "room-uuid-123"],
//	  "start_time": "2026-05-26T09:00:00+08:00",
//	  "end_time":   "2026-05-26T18:00:00+08:00",
//	  "interval":   30
//	}
//
//	response: {
//	  "subjects": [{
//	     "id":         "alice@fsd.gov.hk",
//	     "kind":       "user",
//	     "intervals": [
//	        {"start_time": "2026-05-26T10:00...", "end_time": "...", "status": "busy"}
//	     ]
//	  }]
//	}
//
// Permission model:
//
//   * Authenticated bookers query the endpoint.
//   * Free/busy follows resource visibility: caller can probe a
//     resource id only if domain/booking/visibility.ResourceVisible
//     would return true.
//   * Caller can probe a user email if it belongs to their tenant —
//     no cross-tenant disclosure.
//   * No PII is returned EVER; subject/organiser/URL never appear.
//
// Empty intervals on a known subject means "free for the whole window".
// Unknown subjects are silently dropped from the response so a
// directory probe can't enumerate users via 404 timing.
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

type FreeBusyHandler struct {
	pool      *pgxpool.Pool
	bookings  BookingLookup
	resources ResourceProjectionLookup
}

func NewFreeBusyHandler(pool *pgxpool.Pool, bookings BookingLookup, resources ResourceProjectionLookup) *FreeBusyHandler {
	return &FreeBusyHandler{pool: pool, bookings: bookings, resources: resources}
}

type freeBusyRequest struct {
	Subjects  []string  `json:"subjects"`
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
}

type freeBusyInterval struct {
	StartTime time.Time `json:"start_time"`
	EndTime   time.Time `json:"end_time"`
	Status    string    `json:"status"`
}

type freeBusySubject struct {
	ID        string             `json:"id"`
	Kind      string             `json:"kind"` // "user" | "resource"
	Intervals []freeBusyInterval `json:"intervals"`
}

// Query handles the POST. Validates the input window, classifies each
// subject as user-or-resource, applies the visibility ACL, runs one
// scoped SQL query per kind, and returns the aggregated response.
func (h *FreeBusyHandler) Query(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	var req freeBusyRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	if !req.EndTime.After(req.StartTime) {
		http.Error(w, "end_time must be after start_time", http.StatusBadRequest)
		return
	}
	if req.EndTime.Sub(req.StartTime) > 62*24*time.Hour {
		http.Error(w, "window too wide; max 62 days", http.StatusBadRequest)
		return
	}
	if len(req.Subjects) == 0 || len(req.Subjects) > 100 {
		http.Error(w, "subjects: 1..100 required", http.StatusBadRequest)
		return
	}

	// Classify subjects. Anything that looks like a UUID is treated as
	// a resource id; anything with "@" is a user email; everything else
	// is a user identifier the directory might resolve.
	var resourceIDs, userIdentifiers []string
	for _, s := range req.Subjects {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		if looksLikeUUID(s) {
			resourceIDs = append(resourceIDs, s)
		} else {
			userIdentifiers = append(userIdentifiers, s)
		}
	}

	caller := callerFromCtx(r)
	exec := dbctx.ExecutorFromContext(r.Context(), h.pool)
	out := freeBusyResponse{Subjects: []freeBusySubject{}}

	// --- resources -----------------------------------------------------
	if len(resourceIDs) > 0 {
		projs, err := h.resources.ProjectionsForIDs(r.Context(), tid.String(), resourceIDs)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		visibleIDs := make([]string, 0, len(resourceIDs))
		for _, id := range resourceIDs {
			p, ok := projs[id]
			if !ok {
				continue // unknown resource → silently dropped
			}
			if !booking.ResourceVisible(caller, p) {
				continue // ACL denied → silently dropped
			}
			visibleIDs = append(visibleIDs, id)
		}
		if len(visibleIDs) > 0 {
			rows, err := exec.Query(r.Context(), `
SELECT resource_id::text, start_time, end_time, status
FROM bookings
WHERE tenant_id = $1::uuid
  AND resource_id = ANY($2::uuid[])
  AND status IN ('Confirmed','Pending Approval','Checked In')
  AND start_time < $4 AND end_time > $3
ORDER BY resource_id, start_time`, tid, visibleIDs, req.StartTime, req.EndTime)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			intervalsByID := map[string][]freeBusyInterval{}
			for rows.Next() {
				var id, status string
				var st, et time.Time
				if err := rows.Scan(&id, &st, &et, &status); err != nil {
					continue
				}
				intervalsByID[id] = append(intervalsByID[id], freeBusyInterval{
					StartTime: st, EndTime: et, Status: mapStatus(status),
				})
			}
			rows.Close()
			for _, id := range visibleIDs {
				out.Subjects = append(out.Subjects, freeBusySubject{
					ID:        id,
					Kind:      "resource",
					Intervals: intervalsByID[id],
				})
			}
		}
	}

	// --- users ---------------------------------------------------------
	if len(userIdentifiers) > 0 {
		// Resolve email/username to internal user_id, scoped to tenant.
		// We use a single query so a probe of 50 emails costs one round-
		// trip rather than 50.
		idRows, err := exec.Query(r.Context(), `
SELECT id::text, COALESCE(email, username)
FROM users
WHERE tenant_id = $1::uuid
  AND (LOWER(email) = ANY($2::text[]) OR LOWER(username) = ANY($2::text[]))`,
			tid, lowerAll(userIdentifiers))
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		type userPair struct {
			id    string
			label string
		}
		var users []userPair
		for idRows.Next() {
			var p userPair
			if err := idRows.Scan(&p.id, &p.label); err == nil {
				users = append(users, p)
			}
		}
		idRows.Close()

		for _, u := range users {
			// One query per user — typical scheduling-assistant probes
			// are 1-3 users, so the extra round-trips don't matter and
			// the per-user code path stays trivial to audit.
			rows, err := exec.Query(r.Context(), `
SELECT start_time, end_time, status
FROM bookings
WHERE tenant_id = $1::uuid
  AND user_id = $2::uuid
  AND status IN ('Confirmed','Pending Approval','Checked In')
  AND start_time < $4 AND end_time > $3
ORDER BY start_time`, tid, u.id, req.StartTime, req.EndTime)
			if err != nil {
				continue
			}
			var ivals []freeBusyInterval
			for rows.Next() {
				var st, et time.Time
				var status string
				if err := rows.Scan(&st, &et, &status); err == nil {
					ivals = append(ivals, freeBusyInterval{StartTime: st, EndTime: et, Status: mapStatus(status)})
				}
			}
			rows.Close()
			out.Subjects = append(out.Subjects, freeBusySubject{
				ID:        u.label,
				Kind:      "user",
				Intervals: ivals,
			})
		}
	}

	w.Header().Set("Cache-Control", "private, max-age=15")
	writeJSON(w, http.StatusOK, out)
}

type freeBusyResponse struct {
	Subjects []freeBusySubject `json:"subjects"`
}

// mapStatus normalises internal statuses to the public "busy/tentative"
// vocabulary Outlook & Google use. Tentative covers approval-pending
// rows so an external scheduler can colour them differently.
func mapStatus(s string) string {
	switch s {
	case "Pending Approval":
		return "tentative"
	case "Confirmed", "Checked In":
		return "busy"
	default:
		return "busy"
	}
}

func looksLikeUUID(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, c := range s {
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
				return false
			}
		}
	}
	return true
}

func lowerAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = strings.ToLower(s)
	}
	return out
}
