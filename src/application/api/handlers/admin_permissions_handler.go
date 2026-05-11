package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/permission"
)

// AdminPermissionsHandler exposes the per-tenant role × permission matrix.
//
//   GET    /api/v1/admin/permissions             { tenant_id, roles{role:[perm,…]}, catalog:[…] }
//   PUT    /api/v1/admin/permissions/{role}      { permissions: [perm, …] }
type AdminPermissionsHandler struct {
	repo permission.Repository
}

func NewAdminPermissionsHandler(repo permission.Repository) *AdminPermissionsHandler {
	return &AdminPermissionsHandler{repo: repo}
}

func (h *AdminPermissionsHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/permissions"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		matrix, err := h.repo.Get(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"tenant_id": matrix.TenantID,
			"roles":     matrix.Roles,
			"catalog":   permission.Catalog(),
		})
	case path != "" && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
		var body struct {
			Permissions []string `json:"permissions"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		// Trim and de-duplicate to keep the column clean.
		seen := map[string]struct{}{}
		clean := make([]string, 0, len(body.Permissions))
		for _, p := range body.Permissions {
			p = strings.TrimSpace(p)
			if p == "" {
				continue
			}
			if _, ok := seen[p]; ok {
				continue
			}
			seen[p] = struct{}{}
			clean = append(clean, p)
		}
		if err := h.repo.Set(r.Context(), tenantID.String(), path, clean); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}
