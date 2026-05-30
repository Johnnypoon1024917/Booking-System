package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/floorplan"
)

// AdminFloorPlanHandler exposes CRUD over admin-drawn floor plans.
//
//   GET    /api/v1/admin/floor-plans                  list tenant's plans
//   POST   /api/v1/admin/floor-plans                  create a new plan
//   GET    /api/v1/admin/floor-plans/{id}             fetch one
//   PUT    /api/v1/admin/floor-plans/{id}             update (name, shapes, is_default)
//   DELETE /api/v1/admin/floor-plans/{id}             delete
//   POST   /api/v1/admin/floor-plans/{id}/duplicate   copy shapes into a new plan
//   POST   /api/v1/admin/floor-plans/{id}/default     mark as default for tenant
type AdminFloorPlanHandler struct {
	repo floorplan.Repository
}

func NewAdminFloorPlanHandler(repo floorplan.Repository) *AdminFloorPlanHandler {
	return &AdminFloorPlanHandler{repo: repo}
}

func (h *AdminFloorPlanHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	tid := tenantID.String()

	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/floor-plans")
	path = strings.Trim(path, "/")
	parts := []string{}
	if path != "" {
		parts = strings.Split(path, "/")
	}

	switch {
	case len(parts) == 0 && r.Method == http.MethodGet:
		h.list(w, r, tid)
	case len(parts) == 0 && r.Method == http.MethodPost:
		h.create(w, r, tid)
	case len(parts) == 1 && r.Method == http.MethodGet:
		h.get(w, r, tid, parts[0])
	case len(parts) == 1 && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		h.update(w, r, tid, parts[0])
	case len(parts) == 1 && r.Method == http.MethodDelete:
		h.delete(w, r, tid, parts[0])
	case len(parts) == 2 && parts[1] == "duplicate" && r.Method == http.MethodPost:
		h.duplicate(w, r, tid, parts[0])
	case len(parts) == 2 && parts[1] == "default" && r.Method == http.MethodPost:
		h.setDefault(w, r, tid, parts[0])
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *AdminFloorPlanHandler) list(w http.ResponseWriter, r *http.Request, tenantID string) {
	out, err := h.repo.List(r.Context(), tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminFloorPlanHandler) get(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	fp, err := h.repo.GetByID(r.Context(), tenantID, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, fp)
}

func (h *AdminFloorPlanHandler) create(w http.ResponseWriter, r *http.Request, tenantID string) {
	var p floorplan.FloorPlan
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	p.TenantID = tenantID
	saved, err := h.repo.Create(r.Context(), p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (h *AdminFloorPlanHandler) update(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	var p floorplan.FloorPlan
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(p.Name) == "" {
		http.Error(w, "name is required", http.StatusBadRequest)
		return
	}
	p.ID = id
	p.TenantID = tenantID
	saved, err := h.repo.Update(r.Context(), p)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, saved)
}

func (h *AdminFloorPlanHandler) delete(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	if err := h.repo.Delete(r.Context(), tenantID, id); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// duplicate copies shapes from the source plan into a new row. The new
// name comes from the body so admins can pick something meaningful at
// duplication time (e.g. "Floor 1 — copy" → "Floor 2").
func (h *AdminFloorPlanHandler) duplicate(w http.ResponseWriter, r *http.Request, tenantID, sourceID string) {
	var body struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	name := strings.TrimSpace(body.Name)
	if name == "" {
		// Fall back to "<source name> (copy)" so the duplicate is always
		// findable in the dropdown even if the admin didn't pass a name.
		src, err := h.repo.GetByID(r.Context(), tenantID, sourceID)
		if err != nil {
			http.Error(w, "source floor plan not found", http.StatusNotFound)
			return
		}
		name = src.Name + " (copy)"
	}
	saved, err := h.repo.Duplicate(r.Context(), tenantID, sourceID, name)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, saved)
}

func (h *AdminFloorPlanHandler) setDefault(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	if err := h.repo.SetDefault(r.Context(), tenantID, id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
