package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/auditlog"
)

// maxBookingRangeDays caps how many days a single ?start=&end= query
// is allowed to span. Without a cap an admin could request the entire
// booking history of a tenant in one shot — index-friendly to scan,
// but expensive to marshal/serialise and a nice DoS amplifier. A year
// covers every realistic calendar UI (the SPA Week/Month views never
// span more than 42 days) with headroom for ad-hoc admin reports.
const maxBookingRangeDays = 366

// validateBookingDateRange parses ?start=&end= as YYYY-MM-DD, rejects
// malformed input, enforces start <= end, and caps the span at
// maxBookingRangeDays. Returns "" for either bound when the caller
// passed an empty string, so handlers can fall through to the
// single-date path. err is non-nil for any rejection — handler should
// respond 400 with err.Error() (the messages are user-safe and don't
// leak internal state).
func validateBookingDateRange(startStr, endStr string) (string, string, error) {
	if startStr == "" && endStr == "" {
		return "", "", nil
	}
	if startStr == "" || endStr == "" {
		return "", "", errors.New("both start and end are required when using a range query")
	}
	s, err := time.Parse("2006-01-02", startStr)
	if err != nil {
		return "", "", errors.New("start must be YYYY-MM-DD")
	}
	e, err := time.Parse("2006-01-02", endStr)
	if err != nil {
		return "", "", errors.New("end must be YYYY-MM-DD")
	}
	if e.Before(s) {
		return "", "", errors.New("end must be on or after start")
	}
	if e.Sub(s).Hours()/24 > maxBookingRangeDays {
		return "", "", errors.New("date range exceeds the maximum of 366 days; narrow the window")
	}
	return startStr, endStr, nil
}

// BookingLookup is the small slice of the booking repo this handler needs.
// Declared here so the handler package doesn't import postgres.
type BookingLookup interface {
	FindByID(ctx context.Context, id string) (booking.Booking, error)
	ListByUserUpcoming(ctx context.Context, userID string) ([]booking.Booking, error)
	ListAllForDate(ctx context.Context, tenantID, date string, regionAccess []string) ([]booking.Booking, error)
	ListAllForRange(ctx context.Context, tenantID, start, end string, regionAccess []string) ([]booking.Booking, error)
}

// ResourceProjectionLookup supplies the per-resource ACL projection
// needed by domain/booking/visibility.ProjectMany. Kept as a small
// interface so test fakes don't have to mock the full resource repo.
type ResourceProjectionLookup interface {
	ProjectionsForIDs(ctx context.Context, tenantID string, ids []string) (map[string]booking.ResourceProjection, error)
}

// callerFromCtx pulls the auth fields visibility.go needs. Returned as
// a value (not pointer) so a zero Caller still behaves as "anonymous".
func callerFromCtx(r *http.Request) booking.Caller {
	uid, _ := r.Context().Value("userID").(string)
	role, _ := r.Context().Value("userRole").(string)
	grade, _ := r.Context().Value("userGrade").(string)
	return booking.Caller{UserID: uid, Role: role, Grade: grade}
}

// projectResource builds a small map keyed by resource_id so list
// handlers can run ProjectMany without an N+1 lookup. Empty input
// returns an empty map.
func projectResources(ctx context.Context, lookup ResourceProjectionLookup, tenantID string, bookings []booking.Booking) map[string]booking.ResourceProjection {
	if lookup == nil || len(bookings) == 0 {
		return map[string]booking.ResourceProjection{}
	}
	seen := map[string]struct{}{}
	ids := make([]string, 0, len(bookings))
	for _, b := range bookings {
		if _, ok := seen[b.ResourceID]; ok {
			continue
		}
		seen[b.ResourceID] = struct{}{}
		ids = append(ids, b.ResourceID)
	}
	projs, _ := lookup.ProjectionsForIDs(ctx, tenantID, ids)
	return projs
}

// BookingLifecycleHandler — get, update, cancel, list-mine.
//
//	GET    /api/v1/bookings/{id}     fetch one
//	PUT    /api/v1/bookings/{id}     update time / meeting URL
//	DELETE /api/v1/bookings/{id}     cancel
//	GET    /api/v1/me/bookings       my upcoming bookings
type BookingLifecycleHandler struct {
	bookings  BookingLookup
	resources ResourceProjectionLookup
	updateUC  *usecase.UpdateBookingUseCase
}

func NewBookingLifecycleHandler(b BookingLookup, resLookup ResourceProjectionLookup, uc *usecase.UpdateBookingUseCase) *BookingLifecycleHandler {
	return &BookingLifecycleHandler{bookings: b, resources: resLookup, updateUC: uc}
}

// DispatchOne routes /api/v1/bookings/{id} to the right method.
func (h *BookingLifecycleHandler) DispatchOne(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/bookings/")
	id = strings.Trim(id, "/")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	switch r.Method {
	case http.MethodGet:
		h.get(w, r, id)
	case http.MethodPut, http.MethodPatch:
		h.update(w, r, id)
	case http.MethodDelete:
		h.cancel(w, r, id)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (h *BookingLifecycleHandler) ListMine(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	if uid == "" {
		http.Error(w, "user context missing", http.StatusUnauthorized)
		return
	}
	tid, _ := tenantIDFromCtx(r)
	out, err := h.bookings.ListByUserUpcoming(r.Context(), uid)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// `ListByUserUpcoming` already filters by user_id so every row is
	// "mine" — the projection is a defence-in-depth pass that strips
	// PII from any row that snuck in via a tenant-cross misconfig.
	projs := projectResources(r.Context(), h.resources, tid.String(), out)
	writeJSON(w, http.StatusOK, booking.ProjectMany(callerFromCtx(r), out, projs))
}

// ListAll returns all bookings for a given date (or upcoming if no date).
// Admin-only endpoint for the timetable view.
func (h *BookingLifecycleHandler) ListAll(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	// Extract region access from JWT claims to enforce restrictions.
	regions, _ := r.Context().Value("userRegions").([]string)
	// Accept either ?date= (single day, day-grid view) or
	// ?start=&end= (range, week/month views). Range bounds are
	// validated and capped at maxBookingRangeDays.
	date := r.URL.Query().Get("date")
	start, end, rerr := validateBookingDateRange(r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if rerr != nil {
		http.Error(w, rerr.Error(), http.StatusBadRequest)
		return
	}
	var out []booking.Booking
	var err error
	if start != "" && end != "" {
		out, err = h.bookings.ListAllForRange(r.Context(), tid.String(), start, end, regions)
	} else {
		out, err = h.bookings.ListAllForDate(r.Context(), tid.String(), date, regions)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Admin endpoint: route gating already restricted callers to the
	// management roles. We still funnel through ProjectMany so the
	// is_private flag is respected — even an admin sees "Reserved" on
	// a privacy-marked booking unless they're the owner or a System
	// Admin (the audit backstop).
	projs := projectResources(r.Context(), h.resources, tid.String(), out)
	writeJSON(w, http.StatusOK, booking.ProjectMany(callerFromCtx(r), out, projs))
}

// busyInterval is the minimal projection a non-admin booker needs to
// render "this slot is taken" on a calendar without leaking who took it
// or what for. Everything else — UserID, Title, MeetingURL,
// ExceptionNotes — is deliberately excluded.
type busyInterval struct {
	ResourceID string    `json:"resource_id"`
	StartTime  time.Time `json:"start_time"`
	EndTime    time.Time `json:"end_time"`
	Status     string    `json:"status"`
}

// Busy returns blocking intervals across the tenant's resources so the
// calendar / search UI can render "this slot is taken" without leaking
// who took it or what for. Available to every authenticated booker.
//
// Design follows the Exchange / Google Calendar three-permission model:
//
//	visibility — "this resource exists" — enforced by ResourceRepo.FindAvailable
//	             using tenant_id, is_active, asset_type, is_restricted.
//	free/busy  — "this slot is taken"   — this endpoint, NO PII.
//	details    — "who, what, why"        — admin endpoints only.
//
// The invariant the industry standardises on: free/busy MUST follow
// resource visibility. If a user can see a resource (search returned
// it), they MUST be able to see its busy state — otherwise they hit
// "scheduling conflict" at submit time with no warning. Conversely,
// free/busy NEVER reveals PII; that requires an admin grant.
//
// Today our resource-visibility ACL is (tenant + asset_type +
// is_restricted) only — RegionAccess is admin-side scoping for the
// dashboard and no-show flow, not booker visibility. So this endpoint
// returns tenant-wide busy intervals, which matches the booker's actual
// search reach. If a tenant flag ever adds region-scoped resource
// visibility, mirror the same WHERE clause into ListAllForDate's
// regions arg below — keeping the two in lockstep is what prevents the
// ghost-availability bug.
//
// GET /api/v1/bookings/busy?date=YYYY-MM-DD
func (h *BookingLifecycleHandler) Busy(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	date := r.URL.Query().Get("date")
	start, end, rerr := validateBookingDateRange(r.URL.Query().Get("start"), r.URL.Query().Get("end"))
	if rerr != nil {
		http.Error(w, rerr.Error(), http.StatusBadRequest)
		return
	}
	// nil regions => no region filter (today's resource-visibility ACL
	// already matches that). Promote this to the caller's userRegions
	// the day we add per-region booker visibility, and update
	// ResourceRepo.FindAvailable in the same change.
	var out []booking.Booking
	var err error
	if start != "" && end != "" {
		out, err = h.bookings.ListAllForRange(r.Context(), tid.String(), start, end, nil)
	} else {
		out, err = h.bookings.ListAllForDate(r.Context(), tid.String(), date, nil)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	intervals := make([]busyInterval, 0, len(out))
	for _, b := range out {
		switch b.Status {
		case booking.StatusConfirmed, booking.StatusPendingApproval, booking.StatusCheckedIn:
			intervals = append(intervals, busyInterval{
				ResourceID: b.ResourceID,
				StartTime:  b.StartTime,
				EndTime:    b.EndTime,
				Status:     b.Status,
			})
		}
	}
	w.Header().Set("Cache-Control", "private, max-age=15")
	writeJSON(w, http.StatusOK, intervals)
}

func (h *BookingLifecycleHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if !canAccessBooking(r, b) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	caller := callerFromCtx(r)
	projs := projectResources(r.Context(), h.resources, b.TenantID, []booking.Booking{b})
	resProj := projs[b.ResourceID]
	// Audit private-booking access by anyone other than the owner. This
	// satisfies the "who looked at the VIP meeting?" question that
	// security teams ask after an incident. We emit only when the user
	// actually CAN see details (otherwise the projection scrubs PII so
	// there's no leak to log). The owner viewing their own row is the
	// uninteresting majority case; skip it to keep the audit signal
	// useful.
	if b.IsPrivate && caller.UserID != b.UserID && booking.CanSeeDetails(caller, b, resProj) {
		auditlog.Record(r, auditlog.Event{
			Action:       "BOOKING_PRIVATE_VIEWED",
			Severity:     audit.SeverityWarning,
			TargetEntity: audit.TargetEntityBooking,
			TargetID:     b.ID,
			Next: map[string]interface{}{
				"viewer_role": caller.Role,
				"owner_id":    b.UserID,
			},
		})
	}
	writeJSON(w, http.StatusOK, booking.ProjectBooking(caller, b, resProj))
}

func (h *BookingLifecycleHandler) update(w http.ResponseWriter, r *http.Request, id string) {
	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if !canMutateBooking(r, b) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var p struct {
		StartTime  string  `json:"start_time"`
		EndTime    string  `json:"end_time"`
		MeetingURL *string `json:"meeting_url"`
		Title      *string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	req := usecase.UpdateRequest{BookingID: id, MeetingURL: p.MeetingURL, Title: p.Title}
	if p.StartTime != "" {
		t, err := time.Parse(time.RFC3339, p.StartTime)
		if err != nil {
			http.Error(w, "start_time must be RFC3339", http.StatusBadRequest)
			return
		}
		req.NewStart = t
	}
	if p.EndTime != "" {
		t, err := time.Parse(time.RFC3339, p.EndTime)
		if err != nil {
			http.Error(w, "end_time must be RFC3339", http.StatusBadRequest)
			return
		}
		req.NewEnd = t
	}
	updated, err := h.updateUC.Execute(r.Context(), req)
	if err != nil {
		auditlog.Failure(r, audit.ActionBookingModified, audit.TargetEntityBooking, id, err.Error())
		msg := err.Error()
		switch {
		case errors.Is(err, usecase.ErrInternal):
			// DB/downstream failure — 5xx so middleware.WithTenantTx rolls
			// the reschedule back rather than committing partial state.
			http.Error(w, "Update could not be completed — please try again", http.StatusInternalServerError)
		case errors.Is(err, booking.ErrConcurrencyConflict),
			strings.Contains(msg, "scheduling conflict"),
			strings.Contains(msg, "already at capacity"):
			http.Error(w, msg, http.StatusConflict)
		case strings.Contains(msg, "rejected:"),
			strings.Contains(msg, "must be"),
			strings.Contains(msg, "is inactive"),
			strings.Contains(msg, "designated public holiday"):
			// Business-rule rejection now also fires on update (audit #1).
			http.Error(w, msg, http.StatusUnprocessableEntity)
		default:
			http.Error(w, msg, http.StatusConflict)
		}
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionBookingModified,
		TargetEntity: audit.TargetEntityBooking,
		TargetID:     id,
		Previous:     map[string]interface{}{"start": b.StartTime, "end": b.EndTime, "status": b.Status},
		Next:         map[string]interface{}{"start": updated.StartTime, "end": updated.EndTime, "status": updated.Status},
	})
	writeJSON(w, http.StatusOK, updated)
}

func (h *BookingLifecycleHandler) cancel(w http.ResponseWriter, r *http.Request, id string) {
	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if !canMutateBooking(r, b) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	reason := r.URL.Query().Get("reason")
	if err := h.updateUC.Cancel(r.Context(), id, reason); err != nil {
		auditlog.Failure(r, audit.ActionBookingCancelled, audit.TargetEntityBooking, id, err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionBookingCancelled,
		TargetEntity: audit.TargetEntityBooking,
		TargetID:     id,
		Previous:     map[string]interface{}{"status": b.Status},
		Next:         map[string]interface{}{"status": booking.StatusCancelled, "reason": reason},
	})
	w.WriteHeader(http.StatusNoContent)
}

// sameTenant returns true when the booking belongs to the caller's tenant.
// The repository FindByID does not filter by tenant, so this is the trust
// boundary that prevents cross-tenant IDOR on /api/v1/bookings/{id}.
func sameTenant(r *http.Request, b booking.Booking) bool {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		return false
	}
	return b.TenantID == tid.String()
}

// canAccessBooking — the owner, an admin, or the same tenant's room admin
// can read the booking, AND the booking must belong to the caller's tenant.
func canAccessBooking(r *http.Request, b booking.Booking) bool {
	if !sameTenant(r, b) {
		return false
	}
	uid, _ := r.Context().Value("userID").(string)
	if b.UserID == uid {
		return true
	}
	role, _ := r.Context().Value("userRole").(string)
	switch role {
	case user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin:
		return true
	}
	return false
}

// canMutateBooking — only the owner or an admin in the same tenant can update/cancel.
func canMutateBooking(r *http.Request, b booking.Booking) bool {
	if !sameTenant(r, b) {
		return false
	}
	uid, _ := r.Context().Value("userID").(string)
	if b.UserID == uid {
		return true
	}
	role, _ := r.Context().Value("userRole").(string)
	switch role {
	case user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin:
		return true
	}
	return false
}
