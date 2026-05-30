// Admin-side booking-status overrides.
//
// Today's only endpoint:
//
//	POST /api/v1/admin/bookings/{id}/no-show   body: {"reason":"..."}
//
// Marks another user's booking as "No Show". Tightly restricted:
//
//   * Only System Admin, Room Admin, and Secretary can call it.
//     Security Admin and General User are deliberately NOT in the
//     allowlist; route registration in main.go enforces that.
//   * The booking must belong to the caller's tenant.
//   * Room Admin can only target bookings whose resource sits in one of
//     their assigned regions (matches the existing region-scoping
//     pattern used elsewhere in the SPA).
//   * The booking must currently be in a state that "no-show" makes
//     sense for: Confirmed or Pending Approval. Already-Cancelled,
//     already-No-Show, or Checked-In bookings are rejected.
//
// Audit emission is mandatory — overriding another user's booking is a
// high-impact action and the row must show up in the tamper-evident
// chain so an aggrieved booker can ask "who flipped my room?".
package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminBookingStatusHandler covers admin overrides on a booking's
// lifecycle. The structure is deliberately small so adding more verbs
// (force-checkin, exception override, etc.) lives next to no-show with
// the same audit + scope guards.
type AdminBookingStatusHandler struct {
	pool     *pgxpool.Pool
	bookings BookingLookup
}

func NewAdminBookingStatusHandler(pool *pgxpool.Pool, bookings BookingLookup) *AdminBookingStatusHandler {
	return &AdminBookingStatusHandler{pool: pool, bookings: bookings}
}

// MarkNoShow flips status -> "No Show" with the supplied reason recorded
// in exception_notes. Errors are mapped to HTTP codes that distinguish
// "your input is bad" (400), "you can't touch this row" (403), "row
// already in a non-overridable state" (409), and "something blew up"
// (500) so the SPA can surface useful messages without parsing strings.
func (h *AdminBookingStatusHandler) MarkNoShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := extractBookingID(r.URL.Path)
	if id == "" {
		http.Error(w, "booking id required", http.StatusBadRequest)
		return
	}

	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	role, _ := r.Context().Value("userRole").(string)
	actor, _ := r.Context().Value("userID").(string)
	regions, _ := r.Context().Value("userRegions").([]string)

	// Defense-in-depth — main.go gates this route with the same allowlist,
	// but a second check here means a future refactor can't accidentally
	// loosen access.
	if !roleCanMarkNoShow(role) {
		auditlog.Denied(r, "BOOKING_NO_SHOW", audit.TargetEntityBooking, id, "role "+role+" not allowed")
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	var body struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	reason := strings.TrimSpace(body.Reason)
	if reason == "" {
		reason = "Marked as No Show by " + role
	}

	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if b.TenantID != tid.String() {
		// Don't leak existence of a cross-tenant row — 404 looks the
		// same as a genuinely-missing id.
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	// Room Admin region check. Other allowed roles (System Admin,
	// Secretary) have tenant-wide reach so no further scope test.
	if role == user.RoleRoomAdmin {
		allowed, err := h.bookingInAdminRegion(r.Context(), b.ResourceID, regions)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			auditlog.Denied(r, "BOOKING_NO_SHOW", audit.TargetEntityBooking, id,
				"room admin outside resource region")
			http.Error(w, "forbidden: resource is outside your assigned region", http.StatusForbidden)
			return
		}
	}

	// State validation. We do NOT overwrite Cancelled rows (the booking
	// was withdrawn — calling it "no show" is misleading) and we refuse
	// Checked-In rows (the person actually showed up). Already-No-Show
	// is idempotent: return 200 with a note rather than 409 so the SPA
	// can treat it as a no-op.
	switch b.Status {
	case booking.StatusCancelled, booking.StatusException:
		http.Error(w, "booking is "+b.Status+" and cannot be marked No Show", http.StatusConflict)
		return
	case booking.StatusCheckedIn:
		http.Error(w, "booking was checked in; cannot mark as No Show", http.StatusConflict)
		return
	case booking.StatusNoShow:
		writeJSON(w, http.StatusOK, map[string]string{"status": b.Status, "noop": "true"})
		return
	}

	// Persist. UpdateStatus overwrites exception_notes with the supplied
	// reason so the audit narrative reads cleanly later.
	exec := dbctx.ExecutorFromContext(r.Context(), h.pool)
	if _, err := exec.Exec(r.Context(),
		`UPDATE bookings
		    SET status = $2,
		        exception_notes = $3
		  WHERE id = $1 AND tenant_id = $4`,
		id, booking.StatusNoShow, reason, tid.String()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	auditlog.Record(r, auditlog.Event{
		Action:       "BOOKING_NO_SHOW",
		Severity:     audit.SeverityWarning,
		TargetEntity: audit.TargetEntityBooking,
		TargetID:     id,
		Previous:     map[string]interface{}{"status": b.Status},
		Next: map[string]interface{}{
			"status":     booking.StatusNoShow,
			"reason":     reason,
			"actor_role": role,
			"actor_id":   actor,
			"booking_owner": b.UserID,
		},
	})
	writeJSON(w, http.StatusOK, map[string]string{
		"id":     id,
		"status": booking.StatusNoShow,
		"reason": reason,
	})
}

// roleCanMarkNoShow centralises the allowlist so other endpoints (e.g.
// the future bulk-mark) can reuse the same definition. Mirrored by
// MarkAttended — keep them in sync if the policy widens.
func roleCanMarkNoShow(role string) bool {
	switch role {
	case user.RoleSystemAdmin, user.RoleRoomAdmin, user.RoleSecretary:
		return true
	}
	return false
}

// MarkAttended flips a Confirmed booking to "Checked In" on behalf of
// the organiser — used by reception or the room admin when the booker
// physically arrived but didn't scan the QR code themselves. Same
// allowlist as MarkNoShow.
func (h *AdminBookingStatusHandler) MarkAttended(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := extractBookingID(r.URL.Path)
	if id == "" {
		http.Error(w, "booking id required", http.StatusBadRequest)
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	role, _ := r.Context().Value("userRole").(string)
	actor, _ := r.Context().Value("userID").(string)
	regions, _ := r.Context().Value("userRegions").([]string)

	if !roleCanMarkNoShow(role) {
		auditlog.Denied(r, "BOOKING_ATTENDED", audit.TargetEntityBooking, id, "role "+role+" not allowed")
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}

	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if b.TenantID != tid.String() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if role == user.RoleRoomAdmin {
		allowed, err := h.bookingInAdminRegion(r.Context(), b.ResourceID, regions)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			auditlog.Denied(r, "BOOKING_ATTENDED", audit.TargetEntityBooking, id,
				"room admin outside resource region")
			http.Error(w, "forbidden: resource is outside your assigned region", http.StatusForbidden)
			return
		}
	}

	switch b.Status {
	case booking.StatusCancelled, booking.StatusException, booking.StatusNoShow:
		http.Error(w, "booking is "+b.Status+" and cannot be marked Attended", http.StatusConflict)
		return
	case booking.StatusPendingApproval:
		http.Error(w, "booking is awaiting approval; approve it first", http.StatusConflict)
		return
	case booking.StatusCheckedIn:
		writeJSON(w, http.StatusOK, map[string]string{"status": b.Status, "noop": "true"})
		return
	}

	exec := dbctx.ExecutorFromContext(r.Context(), h.pool)
	if _, err := exec.Exec(r.Context(),
		`UPDATE bookings
		    SET status = $2,
		        checked_in_at = COALESCE(checked_in_at, NOW())
		  WHERE id = $1 AND tenant_id = $3`,
		id, booking.StatusCheckedIn, tid.String()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "BOOKING_ATTENDED",
		Severity:     audit.SeverityInfo,
		TargetEntity: audit.TargetEntityBooking,
		TargetID:     id,
		Previous:     map[string]interface{}{"status": b.Status},
		Next: map[string]interface{}{
			"status":        booking.StatusCheckedIn,
			"actor_role":    role,
			"actor_id":      actor,
			"booking_owner": b.UserID,
		},
	})
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": booking.StatusCheckedIn})
}

// bookingInAdminRegion returns true when the resource attached to the
// booking sits in one of the admin's assigned regions. Empty region
// list = explicit "no permission anywhere" (we fail closed rather than
// fall back to tenant-wide, which would defeat the purpose of regions).
func (h *AdminBookingStatusHandler) bookingInAdminRegion(ctx context.Context, resourceID string, regions []string) (bool, error) {
	if len(regions) == 0 {
		return false, nil
	}
	var region string
	err := dbctx.ExecutorFromContext(ctx, h.pool).
		QueryRow(ctx, `SELECT COALESCE(region,'') FROM resources WHERE id = $1::uuid`, resourceID).
		Scan(&region)
	if err != nil {
		return false, err
	}
	for _, r := range regions {
		if r == region {
			return true, nil
		}
	}
	return false, nil
}

// extractBookingID pulls the {id} segment out of
// /api/v1/admin/bookings/{id}/no-show. Returns "" when the path doesn't
// match that shape.
func extractBookingID(path string) string {
	const prefix = "/api/v1/admin/bookings/"
	if !strings.HasPrefix(path, prefix) {
		return ""
	}
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 0 {
		return ""
	}
	return parts[0]
}

// Re-export errors used by tests so the file is reachable as a public
// surface from package handlers (avoids "unused" complaints in a test
// build without the test file present).
var _ = errors.New
var _ = time.Now
