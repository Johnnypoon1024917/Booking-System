package handlers

import (
	"encoding/json"
	"net/http"

	"fsd-mrbs/src/domain/tenant"

	"github.com/google/uuid"
)

// CustomizationHandler exposes the per-tenant customization document so a
// tenant admin can rebrand and reshape the product without code changes.
//
// All endpoints require an authenticated admin (enforced at the route level
// via RequireRoleHandler with the System Admin / Security Admin roles).
type CustomizationHandler struct {
	repo tenant.Repository
}

func NewCustomizationHandler(repo tenant.Repository) *CustomizationHandler {
	return &CustomizationHandler{repo: repo}
}

// Get returns the active customization document. If none has been saved
// yet for the tenant the handler returns the FSD baseline so the admin UI
// always has something to render.
func (h *CustomizationHandler) Get(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	cust, err := h.repo.Get(r.Context(), tenantID)
	if err != nil {
		http.Error(w, "could not load customization", http.StatusInternalServerError)
		return
	}
	if cust == nil {
		cust = tenant.FSDDefaults(tenantID)
	}
	writeJSON(w, http.StatusOK, cust)
}

// Put replaces the customization document for the tenant. The body is the
// full document (idempotent overwrite is simpler than a diff/patch and the
// document is small enough that bandwidth isn't a concern).
func (h *CustomizationHandler) Put(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}

	var c tenant.Customization
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		http.Error(w, "invalid customization payload", http.StatusBadRequest)
		return
	}
	c.TenantID = tenantID
	if err := c.Validate(); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := h.repo.Save(r.Context(), &c); err != nil {
		http.Error(w, "could not save customization", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, c)
}

// ResetToFSD wipes the document and reseeds with FSD defaults. Useful in
// a demo / training environment.
func (h *CustomizationHandler) ResetToFSD(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	defaults := tenant.FSDDefaults(tenantID)
	if err := h.repo.Save(r.Context(), defaults); err != nil {
		http.Error(w, "could not reset customization", http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, defaults)
}

// tenantIDFromCtx extracts the tenant UUID set by the tenant middleware.
func tenantIDFromCtx(r *http.Request) (uuid.UUID, bool) {
	v := r.Context().Value("tenant_id")
	if v == nil {
		v = r.Context().Value("tenantID")
	}
	switch t := v.(type) {
	case uuid.UUID:
		return t, t != uuid.Nil
	case string:
		id, err := uuid.Parse(t)
		return id, err == nil
	}
	return uuid.Nil, false
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
