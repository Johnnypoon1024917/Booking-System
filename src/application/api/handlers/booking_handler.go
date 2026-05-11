package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"
)

type BookingHandler struct {
	repo booking.ResourceRepository
	uc   *usecase.CreateBookingUseCase
}

func NewBookingHandler(repo booking.ResourceRepository, uc *usecase.CreateBookingUseCase) *BookingHandler {
	return &BookingHandler{repo: repo, uc: uc}
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
		Region:    q.Get("location"),
		AssetType: assetType,
		Capacity:  capacity,
		StartTime: start,
		EndTime:   end,
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

	_, err := h.uc.Execute(r.Context(), req.ResourceID, userID, start, end, tenantID)
	if err != nil {
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

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "FSD Booking Confirmed"})
}
