package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/department"

	"github.com/google/uuid"
)

// AdminDepartmentHandler — CRUD over departments.
type AdminDepartmentHandler struct {
	repo department.Repository
}

func NewAdminDepartmentHandler(repo department.Repository) *AdminDepartmentHandler {
	return &AdminDepartmentHandler{repo: repo}
}

func (h *AdminDepartmentHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/departments"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.repo.List(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case path == "" && r.Method == http.MethodPost:
		var d department.Department
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if d.Name == "" {
			http.Error(w, "name required", http.StatusBadRequest)
			return
		}
		d.ID = uuid.NewString()
		d.TenantID = tenantID.String()
		if err := h.repo.Save(r.Context(), d); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, d)
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
		var d department.Department
		if err := json.NewDecoder(r.Body).Decode(&d); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		d.ID = path
		d.TenantID = tenantID.String()
		if err := h.repo.Save(r.Context(), d); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, d)
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
