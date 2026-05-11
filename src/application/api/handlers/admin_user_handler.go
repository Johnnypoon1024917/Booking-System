package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/google/uuid"
)

// AdminUserHandler — CRUD over users for tenant admins.
//
//   GET    /api/v1/admin/users
//   POST   /api/v1/admin/users
//   GET    /api/v1/admin/users/{id}
//   PUT    /api/v1/admin/users/{id}
//   DELETE /api/v1/admin/users/{id}    (soft delete: is_active=false)
type AdminUserHandler struct {
	repo postgres.UserRepository
}

func NewAdminUserHandler(repo postgres.UserRepository) *AdminUserHandler {
	return &AdminUserHandler{repo: repo}
}

func (h *AdminUserHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/users")
	path = strings.Trim(path, "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.repo.ListByTenant(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case path == "" && r.Method == http.MethodPost:
		var u user.User
		if err := json.NewDecoder(r.Body).Decode(&u); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		if u.Username == "" {
			http.Error(w, "username required", http.StatusBadRequest)
			return
		}
		if u.ID == "" {
			u.ID = uuid.NewString()
		}
		u.TenantID = tenantID.String()
		u.IsActive = true
		if err := h.repo.Save(r.Context(), u); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusCreated, u)
	case r.Method == http.MethodGet:
		id := path
		got, err := h.repo.GetByID(r.Context(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		writeJSON(w, http.StatusOK, got)
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
		id := path
		existing, err := h.repo.GetByID(r.Context(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		var patch user.User
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		patch.ID = existing.ID
		patch.TenantID = tenantID.String()
		if patch.Username == "" {
			patch.Username = existing.Username
		}
		if err := h.repo.Save(r.Context(), patch); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		writeJSON(w, http.StatusOK, patch)
	case r.Method == http.MethodDelete:
		if err := h.repo.SetActive(r.Context(), path, false); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}
