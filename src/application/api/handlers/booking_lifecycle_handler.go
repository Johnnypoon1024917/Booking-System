package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"
)

// BookingLookup is the small slice of the booking repo this handler needs.
// Declared here so the handler package doesn't import postgres.
type BookingLookup interface {
	FindByID(ctx context.Context, id string) (booking.Booking, error)
	ListByUserUpcoming(ctx context.Context, userID string) ([]booking.Booking, error)
	ListAllForDate(ctx context.Context, tenantID, date string) ([]booking.Booking, error)
}

// BookingLifecycleHandler — get, update, cancel, list-mine.
//
//   GET    /api/v1/bookings/{id}     fetch one
//   PUT    /api/v1/bookings/{id}     update time / meeting URL
//   DELETE /api/v1/bookings/{id}     cancel
//   GET    /api/v1/me/bookings       my upcoming bookings
type BookingLifecycleHandler struct {
	bookings BookingLookup
	updateUC *usecase.UpdateBookingUseCase
}

func NewBookingLifecycleHandler(b BookingLookup, uc *usecase.UpdateBookingUseCase) *BookingLifecycleHandler {
	return &BookingLifecycleHandler{bookings: b, updateUC: uc}
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
	out, err := h.bookings.ListByUserUpcoming(r.Context(), uid)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ListAll returns all bookings for a given date (or upcoming if no date).
// Admin-only endpoint for the timetable view.
func (h *BookingLifecycleHandler) ListAll(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	date := r.URL.Query().Get("date")
	out, err := h.bookings.ListAllForDate(r.Context(), tid.String(), date)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
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
	writeJSON(w, http.StatusOK, b)
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
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	req := usecase.UpdateRequest{BookingID: id, MeetingURL: p.MeetingURL}
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
		code := http.StatusConflict
		if errors.Is(err, booking.ErrConcurrencyConflict) {
			code = http.StatusConflict
		}
		http.Error(w, err.Error(), code)
		return
	}
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
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// canAccessBooking — the owner, an admin, or the same tenant's room admin
// can read the booking. Tenant isolation is already enforced upstream.
func canAccessBooking(r *http.Request, b booking.Booking) bool {
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

// canMutateBooking — only the owner or an admin can update/cancel.
func canMutateBooking(r *http.Request, b booking.Booking) bool {
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
