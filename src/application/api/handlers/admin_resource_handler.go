package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/booking"

	"github.com/google/uuid"
)

// AdminResourceHandler exposes CRUD over resources for tenant admins.
//
//   GET    /api/v1/admin/resources              list all resources for tenant
//   POST   /api/v1/admin/resources              create
//   GET    /api/v1/admin/resources/{id}         fetch one (with children)
//   PUT    /api/v1/admin/resources/{id}         update
//   DELETE /api/v1/admin/resources/{id}         soft-delete (set is_active=false)
//   POST   /api/v1/admin/resources/{id}/split   convert into a parent + N children
//   GET    /api/v1/admin/resources/{id}/operating-hours
//   PUT    /api/v1/admin/resources/{id}/operating-hours
type AdminResourceHandler struct {
	repo booking.ResourceRepository
}

func NewAdminResourceHandler(repo booking.ResourceRepository) *AdminResourceHandler {
	return &AdminResourceHandler{repo: repo}
}

func (h *AdminResourceHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/resources")
	path = strings.Trim(path, "/")
	parts := strings.Split(path, "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		h.list(w, r, tenantID)
	case path == "" && r.Method == http.MethodPost:
		h.create(w, r, tenantID)
	case len(parts) == 1 && r.Method == http.MethodGet:
		h.get(w, r, parts[0])
	case len(parts) == 1 && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		h.update(w, r, parts[0], tenantID)
	case len(parts) == 1 && r.Method == http.MethodDelete:
		h.deactivate(w, r, parts[0])
	case len(parts) == 2 && parts[1] == "split" && r.Method == http.MethodPost:
		h.split(w, r, parts[0], tenantID)
	case len(parts) == 2 && parts[1] == "operating-hours" && r.Method == http.MethodGet:
		h.getOperatingHours(w, r, parts[0])
	case len(parts) == 2 && parts[1] == "operating-hours" && r.Method == http.MethodPut:
		h.setOperatingHours(w, r, parts[0])
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *AdminResourceHandler) list(w http.ResponseWriter, r *http.Request, tenantID uuid.UUID) {
	out, err := h.repo.ListByTenant(r.Context(), tenantID.String())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminResourceHandler) get(w http.ResponseWriter, r *http.Request, id string) {
	res, err := h.repo.GetByID(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	children, _ := h.repo.ListChildren(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"resource": res, "children": children})
}

func (h *AdminResourceHandler) create(w http.ResponseWriter, r *http.Request, tenantID uuid.UUID) {
	var res booking.Resource
	if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	res.ID = uuid.NewString()
	res.TenantID = tenantID.String()
	res.IsActive = true
	res.Version = 1
	if res.SubResourceCount < 1 {
		res.SubResourceCount = 1
	}
	if err := h.repo.Save(r.Context(), res); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusCreated, res)
}

func (h *AdminResourceHandler) update(w http.ResponseWriter, r *http.Request, id string, tenantID uuid.UUID) {
	existing, err := h.repo.GetByID(r.Context(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	var patch booking.Resource
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	// merge — only let the admin change what's safe
	patch.ID = existing.ID
	patch.TenantID = tenantID.String()
	patch.Version = existing.Version
	if patch.SubResourceCount < 1 {
		patch.SubResourceCount = existing.SubResourceCount
	}
	if err := h.repo.Save(r.Context(), patch); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}
	writeJSON(w, http.StatusOK, patch)
}

func (h *AdminResourceHandler) deactivate(w http.ResponseWriter, r *http.Request, id string) {
	if err := h.repo.Deactivate(r.Context(), id); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminResourceHandler) getOperatingHours(w http.ResponseWriter, r *http.Request, id string) {
	hours, err := h.repo.GetOperatingHours(r.Context(), id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, hours)
}

func (h *AdminResourceHandler) setOperatingHours(w http.ResponseWriter, r *http.Request, id string) {
	var hours []booking.OperatingHours
	if err := json.NewDecoder(r.Body).Decode(&hours); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	log.Printf("Received operating hours for resource %s: %+v", id, hours)
	for i := range hours {
		hours[i].ResourceID = id
	}
	if err := h.repo.SetOperatingHours(r.Context(), hours); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// split converts a standalone resource into a parent + N children. Useful
// when a basketball court needs to become 3 badminton courts on demand.
//
// Body: { "child_count": 3, "child_capacity": 4, "names": ["Badminton 1", ...] }
func (h *AdminResourceHandler) split(w http.ResponseWriter, r *http.Request, parentID string, tenantID uuid.UUID) {
	var req struct {
		ChildCount    int      `json:"child_count"`
		ChildCapacity int      `json:"child_capacity"`
		ChildNames    []string `json:"child_names"`
		Equipment     []string `json:"child_equipment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	if req.ChildCount < 2 {
		http.Error(w, "child_count must be >= 2", http.StatusBadRequest)
		return
	}
	parent, err := h.repo.GetByID(r.Context(), parentID)
	if err != nil {
		http.Error(w, "parent not found", http.StatusNotFound)
		return
	}

	parent.CompositeMode = booking.CompositeParent
	parent.SubResourceCount = req.ChildCount
	if err := h.repo.Save(r.Context(), *parent); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	created := make([]booking.Resource, 0, req.ChildCount)
	for i := 0; i < req.ChildCount; i++ {
		name := parent.Name
		if i < len(req.ChildNames) && req.ChildNames[i] != "" {
			name = req.ChildNames[i]
		} else {
			name = parent.Name + " · " + ordinal(i+1)
		}
		child := booking.Resource{
			ID:               uuid.NewString(),
			TenantID:         tenantID.String(),
			Name:             name,
			AssetType:        parent.AssetType,
			Region:           parent.Region,
			Location:         parent.Location,
			Capacity:         req.ChildCapacity,
			Equipment:        req.Equipment,
			IsActive:         true,
			ParentResourceID: parent.ID,
			CompositeMode:    booking.CompositeChild,
			SubResourceCount: 1,
			Version:          1,
			DepartmentID:     parent.DepartmentID,
		}
		if err := h.repo.Save(r.Context(), child); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		created = append(created, child)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"parent": parent, "children": created})
}

func ordinal(n int) string {
	switch n {
	case 1:
		return "Court 1"
	case 2:
		return "Court 2"
	case 3:
		return "Court 3"
	case 4:
		return "Court 4"
	case 5:
		return "Court 5"
	default:
		return "Court"
	}
}
