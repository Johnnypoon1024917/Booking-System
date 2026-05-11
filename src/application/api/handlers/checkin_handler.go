package handlers

import (
	"net/http"
	"strings"

	"fsd-mrbs/src/application/usecase"
)

// CheckinHandler exposes the QR redemption endpoint hit by the kiosk
// tablet (or a phone scanning the QR on the booking confirmation).
//
// GET /api/v1/checkin/{token}  → 200 {booking_id} on success
//
// The endpoint is intentionally GET so a QR scan can resolve it without
// JavaScript. Tokens are single-use and tenant-scoped.
type CheckinHandler struct {
	uc *usecase.CheckinUseCase
}

func NewCheckinHandler(uc *usecase.CheckinUseCase) *CheckinHandler {
	return &CheckinHandler{uc: uc}
}

func (h *CheckinHandler) Redeem(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimPrefix(r.URL.Path, "/api/v1/checkin/")
	token = strings.Trim(token, "/")
	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	bookingID, err := h.uc.Redeem(r.Context(), token)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"booking_id": bookingID,
		"status":     "Checked In",
	})
}
