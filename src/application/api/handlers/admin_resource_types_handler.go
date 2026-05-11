// admin_resource_types_handler.go
//
// CRUD for the per-tenant resource-type catalog. Surfaced as
// /api/v1/admin/resource-types — wired into main.go behind the
// "resource_type.manage" permission.
//
// The catalog supplements (does not replace) the built-in keys hard-coded
// in code. Built-in rows are flagged is_builtin=true and cannot be
// deleted; their label/icon/color/defaults can still be overridden.
package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/resourcetype"
)

type AdminResourceTypesHandler struct {
	repo resourcetype.Repository
}

func NewAdminResourceTypesHandler(repo resourcetype.Repository) *AdminResourceTypesHandler {
	return &AdminResourceTypesHandler{repo: repo}
}

func (h *AdminResourceTypesHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, _ := r.Context().Value("tenantID").(string)
	if tenantID == "" {
		tenantID, _ = r.Context().Value("tenant_id").(string)
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/v1/admin/resource-types")
	path = strings.Trim(path, "/")

	switch r.Method {
	case http.MethodGet:
		items, err := h.repo.List(r.Context(), tenantID)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeResourceTypeJSON(w, items)

	case http.MethodPost:
		var t resourcetype.ResourceType
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			http.Error(w, "invalid body", 400)
			return
		}
		t.TenantID = tenantID
		t.IsBuiltin = false
		if t.Key == "" || t.Label == "" {
			http.Error(w, "key and label are required", 400)
			return
		}
		if err := h.repo.Save(r.Context(), t); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeResourceTypeJSON(w, t)

	case http.MethodPut:
		if path == "" {
			http.Error(w, "missing key", 400)
			return
		}
		existing, err := h.repo.Get(r.Context(), tenantID, path)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		if existing == nil {
			http.Error(w, "not found", 404)
			return
		}
		var t resourcetype.ResourceType
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			http.Error(w, "invalid body", 400)
			return
		}
		t.ID = existing.ID
		t.TenantID = tenantID
		t.Key = existing.Key
		t.IsBuiltin = existing.IsBuiltin
		if err := h.repo.Save(r.Context(), t); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		writeResourceTypeJSON(w, t)

	case http.MethodDelete:
		if path == "" {
			http.Error(w, "missing key", 400)
			return
		}
		if err := h.repo.Delete(r.Context(), tenantID, path); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func writeResourceTypeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
