package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/location"
)

// AdminLocationHandler exposes CRUD over first-class Locations.
//
//	GET    /api/v1/locations              read-only list (any booker)
//	GET    /api/v1/admin/locations        list
//	POST   /api/v1/admin/locations        create
//	PUT    /api/v1/admin/locations/{id}   update
//	DELETE /api/v1/admin/locations/{id}   delete
type AdminLocationHandler struct {
	repo location.Repository
}

func NewAdminLocationHandler(repo location.Repository) *AdminLocationHandler {
	return &AdminLocationHandler{repo: repo}
}

// List is the booker-readable endpoint (role-gated, no permission needed)
// so the resource editor's Location dropdown works for everyone.
func (h *AdminLocationHandler) List(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	out, err := h.repo.List(r.Context(), tenantID.String())
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminLocationHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	tid := tenantID.String()
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/locations"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		h.List(w, r)

	case path == "" && r.Method == http.MethodPost:
		l, err := decodeLocation(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		l.TenantID = tid
		saved, err := h.repo.Create(r.Context(), l)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, saved)

	case path != "" && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		l, err := decodeLocation(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		l.ID = path
		l.TenantID = tid
		saved, err := h.repo.Update(r.Context(), l)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, saved)

	case path != "" && r.Method == http.MethodDelete:
		if err := h.repo.Delete(r.Context(), tid, path); err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func decodeLocation(r *http.Request) (location.Location, error) {
	var l location.Location
	if err := json.NewDecoder(r.Body).Decode(&l); err != nil {
		return l, errors.New("invalid payload")
	}
	if strings.TrimSpace(l.Name) == "" {
		return l, errors.New("name is required")
	}
	return l, nil
}
