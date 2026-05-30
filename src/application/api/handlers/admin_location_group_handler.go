package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/locationgroup"
)

// AdminLocationGroupHandler exposes CRUD over location user groups
// (Room Privilege Setup by Organisation Hierarchy — FSD spec p.12).
//
//	GET    /api/v1/admin/location-groups        list tenant's groups
//	POST   /api/v1/admin/location-groups        create
//	PUT    /api/v1/admin/location-groups/{id}   update
//	DELETE /api/v1/admin/location-groups/{id}   delete
type AdminLocationGroupHandler struct {
	repo locationgroup.Repository
}

func NewAdminLocationGroupHandler(repo locationgroup.Repository) *AdminLocationGroupHandler {
	return &AdminLocationGroupHandler{repo: repo}
}

func (h *AdminLocationGroupHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	tid := tenantID.String()

	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/location-groups"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.repo.List(r.Context(), tid)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)

	case path == "" && r.Method == http.MethodPost:
		g, err := decodeGroup(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		g.TenantID = tid
		saved, err := h.repo.Create(r.Context(), g)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, saved)

	case path != "" && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		g, err := decodeGroup(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		g.ID = path
		g.TenantID = tid
		saved, err := h.repo.Update(r.Context(), g)
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

func decodeGroup(r *http.Request) (locationgroup.LocationGroup, error) {
	var g locationgroup.LocationGroup
	if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
		return g, errors.New("invalid payload")
	}
	if strings.TrimSpace(g.Name) == "" {
		return g, errors.New("name is required")
	}
	if g.FilterBy == "" {
		g.FilterBy = "Whitelist"
	}
	if g.Status == "" {
		g.Status = "Active"
	}
	return g, nil
}
