package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/booking"
)

type BookingHandler struct {
	repo booking.ResourceRepository // Assuming this was defined in our previous schema updates
	uc   *usecase.CreateBookingUseCase
}

func NewBookingHandler(repo booking.ResourceRepository, uc *usecase.CreateBookingUseCase) *BookingHandler {
	return &BookingHandler{repo: repo, uc: uc}
}

// SearchAvailableRooms handles the advanced search engine requirements
func (h *BookingHandler) SearchAvailableRooms(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse query parameters for Location, Date, Time, and Capacity
	location := r.URL.Query().Get("location")
	dateStr := r.URL.Query().Get("date") // Format: YYYY-MM-DD
	startTimeStr := r.URL.Query().Get("start_time")
	endTimeStr := r.URL.Query().Get("end_time")

	// Parse times (Error handling omitted for brevity in scaffolding)
	layout := "2006-01-02T15:04"
	startTime, _ := time.Parse(layout, dateStr+"T"+startTimeStr)
	endTime, _ := time.Parse(layout, dateStr+"T"+endTimeStr)

	criteria := booking.SearchCriteria{
		StartTime: startTime,
		EndTime:   endTime,
		Region:    location,
		AssetType: "Room", // Hardcoded for this phase, extensible later
	}

	// Find available resources using the Postgres conflict detection
	availableRooms, err := h.repo.FindAvailable(r.Context(), criteria)
	if err != nil {
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(availableRooms)
}

// CreateBooking handles the strict reservation persistence and PIMM sync
func (h *BookingHandler) CreateBooking(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req struct {
		ResourceID string `json:"resource_id"`
		StartTime  string `json:"start_time"`
		EndTime    string `json:"end_time"`
	}
	json.NewDecoder(r.Body).Decode(&req)

	// Extract user ID from JWT middleware context
	userID := r.Context().Value("userID").(string)

	layout := time.RFC3339
	start, _ := time.Parse(layout, req.StartTime)
	end, _ := time.Parse(layout, req.EndTime)

	// Execute core use case (Optimistic Locking + RabbitMQ Sync)
	_, err := h.uc.Execute(r.Context(), req.ResourceID, userID, start, end)
	if err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "success", "message": "Booking Confirmed"})
}
