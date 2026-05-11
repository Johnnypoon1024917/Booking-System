package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/holiday"
	"fsd-mrbs/src/infrastructure/external"

	"github.com/google/uuid"
)

// AdminHolidayHandler — CRUD + bulk import.
//
//   GET    /api/v1/admin/holidays                 list
//   POST   /api/v1/admin/holidays                 create one
//   PUT    /api/v1/admin/holidays/{id}            update
//   DELETE /api/v1/admin/holidays/{id}            delete
//   POST   /api/v1/admin/holidays/import-ics      multipart upload (file=...)
//   POST   /api/v1/admin/holidays/sync-hk         pull live gov.hk feed
type AdminHolidayHandler struct {
	repo       holiday.Repository
	hkClient   *external.GovHKHolidayClient
	defaultUID string // user UUID stamped on system-imported holidays
}

func NewAdminHolidayHandler(repo holiday.Repository, hk *external.GovHKHolidayClient, defaultUID string) *AdminHolidayHandler {
	return &AdminHolidayHandler{repo: repo, hkClient: hk, defaultUID: defaultUID}
}

func (h *AdminHolidayHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/holidays"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		list, err := h.repo.FindAllByTenant(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, list)
	case path == "" && r.Method == http.MethodPost:
		h.create(w, r, tenantID.String())
	case path == "import-ics" && r.Method == http.MethodPost:
		h.importICS(w, r, tenantID.String())
	case path == "sync-hk" && r.Method == http.MethodPost:
		h.syncHK(w, r, tenantID.String())
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
		h.update(w, r, path, tenantID.String())
	case r.Method == http.MethodDelete:
		if err := h.repo.Delete(r.Context(), path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *AdminHolidayHandler) create(w http.ResponseWriter, r *http.Request, tenantID string) {
	var p struct {
		Date        string `json:"date"`
		Description string `json:"description"`
		IsBlocker   bool   `json:"is_blocker"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	d, err := time.Parse("2006-01-02", p.Date)
	if err != nil {
		http.Error(w, "date must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}
	hol := holiday.Holiday{
		ID:          uuid.NewString(),
		TenantID:    tenantID,
		HolidayDate: d,
		Description: p.Description,
		IsBlocker:   p.IsBlocker,
		CreatedBy:   h.userIDOrDefault(r),
		CreatedAt:   time.Now(),
	}
	if err := h.repo.Save(r.Context(), hol); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusCreated, hol)
}

func (h *AdminHolidayHandler) update(w http.ResponseWriter, r *http.Request, id, tenantID string) {
	var p struct {
		Date        string `json:"date"`
		Description string `json:"description"`
		IsBlocker   bool   `json:"is_blocker"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	d, err := time.Parse("2006-01-02", p.Date)
	if err != nil {
		http.Error(w, "date must be YYYY-MM-DD", http.StatusBadRequest)
		return
	}
	hol := holiday.Holiday{
		ID:          id,
		TenantID:    tenantID,
		HolidayDate: d,
		Description: p.Description,
		IsBlocker:   p.IsBlocker,
		CreatedBy:   h.userIDOrDefault(r),
		CreatedAt:   time.Now(),
	}
	if err := h.repo.Save(r.Context(), hol); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, hol)
}

// importICS accepts a multipart upload and parses the .ics file using
// the same parser as the gov.hk client. Idempotent per (tenant, date).
func (h *AdminHolidayHandler) importICS(w http.ResponseWriter, r *http.Request, tenantID string) {
	if err := r.ParseMultipartForm(2 << 20); err != nil {
		http.Error(w, "invalid multipart payload", http.StatusBadRequest)
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "missing file field", http.StatusBadRequest)
		return
	}
	defer file.Close()

	body, err := io.ReadAll(io.LimitReader(file, 4<<20))
	if err != nil {
		http.Error(w, "could not read file", http.StatusBadRequest)
		return
	}
	holidays, err := external.ParseICSHolidaysReader(bytes.NewReader(body))
	if err != nil {
		http.Error(w, "could not parse ICS: "+err.Error(), http.StatusBadRequest)
		return
	}

	imported, skipped := 0, 0
	uid := h.userIDOrDefault(r)
	for _, hh := range holidays {
		existing, _ := h.repo.FindByTenantAndDate(r.Context(), tenantID, hh.Date)
		if existing != nil {
			skipped++
			continue
		}
		if err := h.repo.Save(r.Context(), holiday.Holiday{
			ID:          uuid.NewString(),
			TenantID:    tenantID,
			HolidayDate: hh.Date,
			Description: hh.Description,
			IsBlocker:   true,
			CreatedBy:   uid,
			CreatedAt:   time.Now(),
		}); err == nil {
			imported++
		}
	}
	writeJSON(w, http.StatusOK, map[string]int{"imported": imported, "skipped": skipped})
}

// syncHK pulls the live gov.hk feed.
func (h *AdminHolidayHandler) syncHK(w http.ResponseWriter, r *http.Request, tenantID string) {
	if h.hkClient == nil {
		http.Error(w, "gov.hk client not configured", http.StatusServiceUnavailable)
		return
	}
	feed, err := h.hkClient.Fetch(r.Context(), "en")
	if err != nil {
		http.Error(w, "fetch failed: "+err.Error(), http.StatusBadGateway)
		return
	}
	imported, skipped := 0, 0
	uid := h.userIDOrDefault(r)
	for _, hh := range feed {
		existing, _ := h.repo.FindByTenantAndDate(r.Context(), tenantID, hh.Date)
		if existing != nil {
			skipped++
			continue
		}
		_ = h.repo.Save(r.Context(), holiday.Holiday{
			ID:          uuid.NewString(),
			TenantID:    tenantID,
			HolidayDate: hh.Date,
			Description: hh.Description,
			IsBlocker:   true,
			CreatedBy:   uid,
			CreatedAt:   time.Now(),
		})
		imported++
	}
	writeJSON(w, http.StatusOK, map[string]int{"imported": imported, "skipped": skipped})
}

// userIDOrDefault resolves the acting user's id from the JWT context, falling
// back to the configured default. Returns "" when no usable id is available
// so the repo's NULLIF($n,'')::uuid wrapper turns it into a SQL NULL — using
// uuid.Nil here would still violate the FK to users.id.
func (h *AdminHolidayHandler) userIDOrDefault(r *http.Request) string {
	if uid, ok := r.Context().Value("userID").(string); ok && uid != "" {
		if _, err := uuid.Parse(uid); err == nil {
			return uid
		}
	}
	if h.defaultUID != "" {
		if _, err := uuid.Parse(h.defaultUID); err == nil {
			return h.defaultUID
		}
	}
	return ""
}

// silence unused import linter if io is the only consumer above
var _ = errors.New
