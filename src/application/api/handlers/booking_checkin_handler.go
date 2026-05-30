package handlers

import (
	"context"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/booking"
)

// BookingCheckinStore is the slice of the booking repo this handler needs.
type BookingCheckinStore interface {
	FindByID(ctx context.Context, id string) (booking.Booking, error)
	UpdateStatus(ctx context.Context, id, status, notes string) error
}

// BookingCheckinHandler powers the dashboard "quick check-in" action
// (FSD spec §2 Module A / §3.3). It flips a booking to "Checked In" so
// the no-show automation no longer flags it.
//
//	POST /api/v1/bookings/checkin/{id}
type BookingCheckinHandler struct {
	bookings BookingCheckinStore
}

func NewBookingCheckinHandler(b BookingCheckinStore) *BookingCheckinHandler {
	return &BookingCheckinHandler{bookings: b}
}

func (h *BookingCheckinHandler) Checkin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	id := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/bookings/checkin/"), "/")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	b, err := h.bookings.FindByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	tid, ok := tenantIDFromCtx(r)
	if !ok || b.TenantID != tid.String() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if b.Status == booking.StatusCancelled {
		http.Error(w, "cannot check in a cancelled booking", http.StatusConflict)
		return
	}
	if err := h.bookings.UpdateStatus(r.Context(), id, booking.StatusCheckedIn, "checked in via dashboard"); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": booking.StatusCheckedIn})
}
