package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/broadcast"

	"github.com/google/uuid"
)

// BroadcastHandler powers FSD Broadcast Messaging (R13): urgent,
// department-wide announcements optionally scoped to rooms / a date range,
// surfaced as a header banner to every targeted user.
//
//	GET    /api/v1/broadcasts                  active broadcasts (all users)
//	GET    /api/v1/admin/broadcasts            list all (admin)
//	POST   /api/v1/admin/broadcasts            create
//	PUT    /api/v1/admin/broadcasts/{id}       update
//	DELETE /api/v1/admin/broadcasts/{id}       delete
type BroadcastHandler struct {
	repo broadcast.Repository
}

func NewBroadcastHandler(repo broadcast.Repository) *BroadcastHandler {
	return &BroadcastHandler{repo: repo}
}

type broadcastPayload struct {
	Title     string                 `json:"title"`
	Content   string                 `json:"content"`
	ImageURL  string                 `json:"image_url"`
	Severity  string                 `json:"severity"` // info | warning | urgent
	StartDate string                 `json:"start_date"`
	EndDate   string                 `json:"end_date"`
	Filters   map[string]interface{} `json:"filters"`
}

func broadcastToJSON(b broadcast.Broadcast) map[string]interface{} {
	sev := "info"
	if b.Filters != nil {
		if s, ok := b.Filters["severity"].(string); ok && s != "" {
			sev = s
		}
	}
	return map[string]interface{}{
		"id":         b.ID,
		"title":      b.Title,
		"content":    b.Content,
		"image_url":  b.ImageURL,
		"severity":   sev,
		"start_date": b.StartDate.Format(time.RFC3339),
		"end_date":   b.EndDate.Format(time.RFC3339),
		"filters":    b.Filters,
		"created_by": b.CreatedBy,
		"created_at": b.CreatedAt.Format(time.RFC3339),
	}
}

// ActiveForUser is the lightweight endpoint the SPA header polls.
func (h *BroadcastHandler) ActiveForUser(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	list, err := h.repo.FindActive(r.Context(), tid.String(), time.Now())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	out := make([]map[string]interface{}, 0, len(list))
	for _, b := range list {
		out = append(out, broadcastToJSON(b))
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *BroadcastHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	tenantID := tid.String()
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/broadcasts"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		list, err := h.repo.FindByTenant(r.Context(), tenantID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out := make([]map[string]interface{}, 0, len(list))
		for _, b := range list {
			out = append(out, broadcastToJSON(b))
		}
		writeJSON(w, http.StatusOK, out)

	case path == "" && r.Method == http.MethodPost:
		h.upsert(w, r, tenantID, "")

	case path != "" && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		h.upsert(w, r, tenantID, path)

	case path != "" && r.Method == http.MethodDelete:
		if err := h.repo.Delete(r.Context(), path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *BroadcastHandler) upsert(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	var p broadcastPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(p.Title) == "" || strings.TrimSpace(p.Content) == "" {
		http.Error(w, "title and content are required", http.StatusBadRequest)
		return
	}
	start := parseTimeOrNow(p.StartDate)
	end := parseTimeOrDefault(p.EndDate, start.Add(24*time.Hour))

	filters := p.Filters
	if filters == nil {
		filters = map[string]interface{}{}
	}
	if p.Severity != "" {
		filters["severity"] = p.Severity
	}

	uid, _ := r.Context().Value("userID").(string)
	b := broadcast.Broadcast{
		ID:        id,
		TenantID:  tenantID,
		Title:     p.Title,
		Content:   p.Content,
		ImageURL:  p.ImageURL,
		StartDate: start,
		EndDate:   end,
		Filters:   filters,
		CreatedBy: uid,
		CreatedAt: time.Now(),
	}
	if b.ID == "" {
		b.ID = uuid.NewString()
	}
	if err := h.repo.Save(r.Context(), b); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	status := http.StatusOK
	if id == "" {
		status = http.StatusCreated
	}
	writeJSON(w, status, broadcastToJSON(b))
}

func parseTimeOrNow(s string) time.Time {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t
	}
	return time.Now()
}

func parseTimeOrDefault(s string, def time.Time) time.Time {
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		// inclusive end-of-day
		return t.Add(24*time.Hour - time.Second)
	}
	return def
}
