// admin_permission_catalog_handler.go
//
// Surface admin-extensible permission groups + custom permission keys.
// Endpoints (all under "permission.manage"):
//   GET    /api/v1/admin/permission-catalog                 → built-in + custom merged view
//   POST   /api/v1/admin/permission-catalog/groups          → create custom group
//   DELETE /api/v1/admin/permission-catalog/groups/{key}    → delete custom group
//   POST   /api/v1/admin/permission-catalog/permissions     → create custom permission
//   DELETE /api/v1/admin/permission-catalog/permissions/{k} → delete custom permission
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/permission"
)

type AdminPermissionCatalogHandler struct {
	repo permission.CatalogRepository
}

func NewAdminPermissionCatalogHandler(repo permission.CatalogRepository) *AdminPermissionCatalogHandler {
	return &AdminPermissionCatalogHandler{repo: repo}
}

type catalogResponse struct {
	Builtin           []permission.Group            `json:"builtin"`
	CustomGroups      []permission.CustomGroup      `json:"custom_groups"`
	CustomPermissions []permission.CustomPermission `json:"custom_permissions"`
}

func (h *AdminPermissionCatalogHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, _ := r.Context().Value("tenantID").(string)
	if tenantID == "" {
		tenantID, _ = r.Context().Value("tenant_id").(string)
	}
	tail := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/permission-catalog")
	tail = strings.Trim(tail, "/")

	switch {
	case tail == "" && r.Method == http.MethodGet:
		groups, err := h.repo.ListGroups(r.Context(), tenantID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		perms, err := h.repo.ListPermissions(r.Context(), tenantID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeCatalogJSON(w, catalogResponse{
			Builtin:           permission.Catalog(),
			CustomGroups:      groups,
			CustomPermissions: perms,
		})

	case strings.HasPrefix(tail, "groups"):
		key := strings.TrimPrefix(tail, "groups")
		key = strings.Trim(key, "/")
		switch r.Method {
		case http.MethodPost:
			var g permission.CustomGroup
			if err := json.NewDecoder(r.Body).Decode(&g); err != nil {
				http.Error(w, "invalid body", 400)
				return
			}
			g.TenantID = tenantID
			if g.Key == "" || g.Label == "" {
				http.Error(w, "key and label are required", 400)
				return
			}
			if err := h.repo.SaveGroup(r.Context(), g); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			writeCatalogJSON(w, g)
		case http.MethodDelete:
			if key == "" {
				http.Error(w, "missing key", 400)
				return
			}
			if err := h.repo.DeleteGroup(r.Context(), tenantID, key); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}

	case strings.HasPrefix(tail, "permissions"):
		key := strings.TrimPrefix(tail, "permissions")
		key = strings.Trim(key, "/")
		switch r.Method {
		case http.MethodPost:
			var p permission.CustomPermission
			if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
				http.Error(w, "invalid body", 400)
				return
			}
			p.TenantID = tenantID
			if p.Key == "" || p.Label == "" || p.GroupKey == "" {
				http.Error(w, "key, label and group_key are required", 400)
				return
			}
			if err := h.repo.SavePermission(r.Context(), p); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			writeCatalogJSON(w, p)
		case http.MethodDelete:
			if key == "" {
				http.Error(w, "missing key", 400)
				return
			}
			if err := h.repo.DeletePermission(r.Context(), tenantID, key); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			w.WriteHeader(http.StatusNoContent)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}

	default:
		http.NotFound(w, r)
	}
}

func writeCatalogJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
