package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/tenant"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/auditlog"
)

// CustomizationLookup is the tiny slice of the customization repo this
// handler needs. Kept narrow so test fakes don't have to mock the full
// CustomizationRepo surface.
type CustomizationLookup interface {
	Get(ctx context.Context, tenantID uuid.UUID) (*tenant.Customization, error)
}

type BookingHandler struct {
	repo      booking.ResourceRepository
	uc        *usecase.CreateBookingUseCase
	custom    CustomizationLookup
	recurring *usecase.ExpandRecurringBookingUseCase
}

func NewBookingHandler(repo booking.ResourceRepository, uc *usecase.CreateBookingUseCase, custom CustomizationLookup) *BookingHandler {
	return &BookingHandler{repo: repo, uc: uc, custom: custom}
}

// WithRecurrence wires the recurring-booking expansion use case. When set,
// CreateBooking will expand a request that carries a `recurrence` block into
// a whole series instead of silently dropping it (QA #4 — the use case was
// previously constructed and discarded in main.go).
func (h *BookingHandler) WithRecurrence(uc *usecase.ExpandRecurringBookingUseCase) *BookingHandler {
	h.recurring = uc
	return h
}

// tenantTimezone resolves the tenant's IANA timezone from customization,
// falling back to the FSD default (Asia/Hong_Kong) when it can't be loaded.
// Used by the availability queries so a wall-clock search window is compared
// against true-UTC stored bookings in the right zone (QA #1).
func (h *BookingHandler) tenantTimezone(ctx context.Context, tenantStr string) string {
	const def = "Asia/Hong_Kong"
	if h.custom == nil || tenantStr == "" {
		return def
	}
	tid, err := uuid.Parse(tenantStr)
	if err != nil {
		return def
	}
	if c, err := h.custom.Get(ctx, tid); err == nil && c != nil && c.Timezone != "" {
		return c.Timezone
	}
	return def
}

func (h *BookingHandler) SearchAvailableRooms(w http.ResponseWriter, r *http.Request) {
	slog.Info("SearchAvailableRooms received request", "url", r.URL.String())
	q := r.URL.Query()

	// asset_type is optional — empty means "any type" so a room saved as
	// "Meeting Room", "Conference", etc. still surfaces.
	assetType := q.Get("asset_type")

	capacity, _ := strconv.Atoi(q.Get("capacity"))
	if capacity < 1 {
		capacity = 1
	}

	// Combine date (YYYY-MM-DD) with start/end (HH:MM) the SPA sends.
	// Fall back to a wide window so the search still returns results when
	// the client omits time params.
	date := q.Get("date")
	start, end := parseSearchWindow(date, q.Get("start_time"), q.Get("end_time"))

	var tenantStr string
	if tenantID, ok := tenantIDFromCtx(r); ok {
		tenantStr = tenantID.String()
	}

	criteria := booking.SearchCriteria{
		TenantID:  tenantStr,
		Location:  q.Get("location"),
		AssetType: assetType,
		Capacity:  capacity,
		StartTime: start,
		EndTime:   end,
		AllDay:    q.Get("all_day") == "true" || q.Get("all_day") == "1",
		Timezone:  h.tenantTimezone(r.Context(), tenantStr),
	}

	role, _ := r.Context().Value("userRole").(string)
	if role == "" {
		role, _ = r.Context().Value("role").(string)
	}
	requestingUser := user.User{Role: role}

	available, err := h.repo.FindAvailable(r.Context(), criteria, requestingUser)
	if err != nil {
		slog.Error("search rooms failed", "err", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if available == nil {
		available = []booking.Resource{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(available)
}

// SuggestSlots — market-grade "next available time" helper. Given the
// caller's current search criteria, walk forward in 30-minute steps from
// the requested start time, calling FindAvailable for each candidate
// window, and return the first N windows that have at least one matching
// room. Used by the SPA's Search page to show "if your time doesn't work,
// try these" chips alongside the room list.
//
// Query params: same shape as /bookings/search (location, date, start_time,
// end_time, capacity, asset_type) plus optional ?limit=5.
//
// Algorithm notes:
//   - The window duration is preserved (end - start); we just slide it.
//   - Steps of 30 minutes — typical booking granularity in this product.
//   - Max search horizon = 48 hours from the requested start to keep the
//     loop bounded even on quiet days.
//   - Each candidate is a full FindAvailable call. We stop as soon as we
//     have `limit` matches.
func (h *BookingHandler) SuggestSlots(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()

	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit < 1 || limit > 20 {
		limit = 5
	}

	capacity, _ := strconv.Atoi(q.Get("capacity"))
	if capacity < 1 {
		capacity = 1
	}

	date := q.Get("date")
	start, end := parseSearchWindow(date, q.Get("start_time"), q.Get("end_time"))
	if !end.After(start) {
		end = start.Add(time.Hour)
	}
	duration := end.Sub(start)

	var tenantStr string
	if tenantID, ok := tenantIDFromCtx(r); ok {
		tenantStr = tenantID.String()
	}
	role, _ := r.Context().Value("userRole").(string)
	requestingUser := user.User{Role: role}
	tz := h.tenantTimezone(r.Context(), tenantStr)

	const step = 30 * time.Minute
	const horizon = 48 * time.Hour
	deadline := start.Add(horizon)

	// Resolve the tenant's working hours so we never suggest a slot
	// outside the calendar's open period (e.g. 23:00-00:00 when the
	// office closes at 20:00). Falls back to the FSD defaults if the
	// customization can't be loaded — the same defaults the SPA's day
	// grid applies. Loaded once outside the loop so we don't re-query
	// per candidate.
	openHour, closeHour := 8, 20
	if h.custom != nil && tenantStr != "" {
		if tid, parseErr := uuid.Parse(tenantStr); parseErr == nil {
			if c, cerr := h.custom.Get(r.Context(), tid); cerr == nil && c != nil {
				if c.CalendarStartHour > 0 || c.CalendarEndHour > 0 {
					openHour = c.CalendarStartHour
					closeHour = c.CalendarEndHour
				}
			}
		}
	}

	type Suggestion struct {
		StartTime      string            `json:"start_time"`
		EndTime        string            `json:"end_time"`
		Date           string            `json:"date"`
		AvailableCount int               `json:"available_count"`
		SampleRoom     *booking.Resource `json:"sample_room,omitempty"`
	}
	out := make([]Suggestion, 0, limit)

	for t := start; t.Before(deadline) && len(out) < limit; t = t.Add(step) {
		windowEnd := t.Add(duration)
		// Skip candidates that fall outside the tenant's working hours.
		// A slot is in-hours iff its start hour is >= openHour AND its
		// end is <= closeHour:00 on the same calendar day. The end-day
		// check rejects 23:00-00:00 (end rolls into next day, hour 0).
		startHour := t.Hour()
		endHour := windowEnd.Hour()
		crossesMidnight := !sameDay(t, windowEnd)
		if startHour < openHour || crossesMidnight || endHour > closeHour ||
			(endHour == closeHour && windowEnd.Minute() > 0) {
			continue
		}
		criteria := booking.SearchCriteria{
			TenantID:  tenantStr,
			Location:  q.Get("location"),
			AssetType: q.Get("asset_type"),
			Capacity:  capacity,
			StartTime: t,
			EndTime:   windowEnd,
			Timezone:  tz,
		}
		rooms, err := h.repo.FindAvailable(r.Context(), criteria, requestingUser)
		if err != nil {
			// One window's failure shouldn't kill the whole suggestion list.
			slog.Warn("suggest-slots: window query failed", "at", t, "err", err)
			continue
		}
		if len(rooms) == 0 {
			continue
		}
		s := Suggestion{
			StartTime:      t.Format("15:04"),
			EndTime:        windowEnd.Format("15:04"),
			Date:           t.Format("2006-01-02"),
			AvailableCount: len(rooms),
		}
		// Sample the first matching room so the UI can preview the
		// suggestion without a second round trip.
		s.SampleRoom = &rooms[0]
		out = append(out, s)
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(out)
}

// sameDay reports whether a and b fall on the same calendar day in
// their own location. Used to reject suggested slots that cross
// midnight — those are out of working hours by definition.
func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}

func parseSearchWindow(date, startStr, endStr string) (time.Time, time.Time) {
	if date == "" {
		date = time.Now().Format("2006-01-02")
	}
	if startStr == "" {
		startStr = "00:00"
	}
	if endStr == "" {
		endStr = "23:59"
	}
	start, err := time.Parse("2006-01-02 15:04", date+" "+startStr)
	if err != nil {
		start = time.Now()
	}
	end, err := time.Parse("2006-01-02 15:04", date+" "+endStr)
	if err != nil {
		end = start.Add(time.Hour)
	}
	return start, end
}

func (h *BookingHandler) CreateBooking(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ResourceID string `json:"resource_id"`
		StartTime  string `json:"start_time"`
		EndTime    string `json:"end_time"`
		// Optional fields the SPA's BookingModal has been sending for
		// some time but which the API was silently dropping. Storing
		// `title` lets calendars render the meeting subject the way
		// Outlook / Teams do, instead of every block reading "Reserved".
		Title      string `json:"title"`
		MeetingURL string `json:"meeting_url"`
		// IsPrivate carries the Outlook-style privacy toggle the SPA
		// adds in BookingModal. When true, only the owner + System
		// Admin see organiser / subject; everyone else gets "Reserved".
		IsPrivate bool `json:"is_private"`
		// Recurrence carries the "Make this recurring" block from the SPA's
		// BookingModal. Previously decoded by nothing and silently dropped
		// (QA #4). When present with count > 1 we expand into a series.
		Recurrence *struct {
			Pattern string `json:"pattern"`
			Count   int    `json:"count"`
		} `json:"recurrence"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid Request", http.StatusBadRequest)
		return
	}

	userID := r.Context().Value("userID").(string)
	// Extract tenant ID from context and pass it to the use case
	var tenantID string
	if tid, ok := tenantIDFromCtx(r); ok {
		tenantID = tid.String()
	}
	start, _ := time.Parse(time.RFC3339, req.StartTime)
	end, _ := time.Parse(time.RFC3339, req.EndTime)

	// Recurring path: expand the pattern into a series and return the
	// recurrence id + skipped clashes. Falls through to the single-booking
	// path when no recurrence block is sent or it only asks for one
	// occurrence.
	if h.recurring != nil && req.Recurrence != nil && req.Recurrence.Count > 1 {
		res, rerr := h.recurring.Execute(r.Context(), usecase.ExpandRecurringBookingRequest{
			TenantID:   tenantID,
			ResourceID: req.ResourceID,
			UserID:     userID,
			Pattern:    req.Recurrence.Pattern,
			FirstStart: start,
			FirstEnd:   end,
			Count:      req.Recurrence.Count,
			MeetingURL: req.MeetingURL,
		})
		if rerr != nil {
			auditlog.Failure(r, audit.ActionBookingCreated, audit.TargetEntityBooking, req.ResourceID, rerr.Error())
			slog.Error("recurring booking failed", "err", rerr.Error(), "user", userID, "resource", req.ResourceID)
			http.Error(w, rerr.Error(), http.StatusUnprocessableEntity)
			return
		}
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionBookingCreated,
			TargetEntity: audit.TargetEntityBooking,
			TargetID:     res.RecurrenceID,
			Next: map[string]interface{}{"resource_id": req.ResourceID, "recurrence_id": res.RecurrenceID,
				"created": len(res.BookingIDs), "skipped": len(res.Skipped)},
		})
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status": "success", "message": "FSD Recurring Booking Confirmed",
			"recurrence_id": res.RecurrenceID, "booking_ids": res.BookingIDs, "skipped": res.Skipped,
		})
		return
	}

	result, err := h.uc.ExecuteRequest(r.Context(), usecase.Request{
		TenantID:   tenantID,
		ResourceID: req.ResourceID,
		UserID:     userID,
		Start:      start,
		End:        end,
		Title:      strings.TrimSpace(req.Title),
		MeetingURL: req.MeetingURL,
		IsPrivate:  req.IsPrivate,
	})
	created := result.BookingID
	if err != nil {
		auditlog.Failure(r, audit.ActionBookingCreated, audit.TargetEntityBooking, req.ResourceID, err.Error())
		// Map error categories to proper status codes. Internal errors are
		// logged with full detail but the client only sees a generic msg.
		msg := err.Error()
		switch {
		case strings.Contains(msg, "rejected: a scheduling conflict"),
			strings.Contains(msg, "already at capacity"),
			strings.Contains(msg, "optimistic locking"):
			http.Error(w, msg, http.StatusConflict)
		case strings.Contains(msg, "must be"),
			strings.Contains(msg, "is inactive"),
			strings.Contains(msg, "designated public holiday"),
			strings.Contains(msg, "active-booking limit"):
			http.Error(w, msg, http.StatusUnprocessableEntity)
		case strings.Contains(msg, "check failed"):
			slog.Error("booking db error", "err", msg, "user", userID, "resource", req.ResourceID)
			http.Error(w, "Booking unavailable — please try a different time slot", http.StatusServiceUnavailable)
		default:
			slog.Error("booking failed", "err", msg, "user", userID, "resource", req.ResourceID)
			http.Error(w, msg, http.StatusBadRequest)
		}
		return
	}

	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionBookingCreated,
		TargetEntity: audit.TargetEntityBooking,
		TargetID:     created,
		Next:         map[string]interface{}{"resource_id": req.ResourceID, "start": start, "end": end},
	})
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "FSD Booking Confirmed", "booking_id": created})
}
