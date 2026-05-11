package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/approval"

	"github.com/google/uuid"
)

// AdminApprovalRulesHandler — CRUD over approval_rules.
//
//   GET    /api/v1/admin/approval-rules
//   POST   /api/v1/admin/approval-rules
//   PUT    /api/v1/admin/approval-rules/{id}
//   DELETE /api/v1/admin/approval-rules/{id}
type AdminApprovalRulesHandler struct {
	repo approval.RuleRepository
}

func NewAdminApprovalRulesHandler(r approval.RuleRepository) *AdminApprovalRulesHandler {
	return &AdminApprovalRulesHandler{repo: r}
}

func (h *AdminApprovalRulesHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/approval-rules"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.repo.List(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case path == "" && r.Method == http.MethodPost:
		var ru approval.Rule
		if err := json.NewDecoder(r.Body).Decode(&ru); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		ru.ID = uuid.NewString()
		ru.TenantID = tenantID.String()
		if ru.Priority == 0 {
			ru.Priority = 100
		}
		ru.IsActive = true
		if err := h.repo.Save(r.Context(), ru); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, ru)
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
		var ru approval.Rule
		if err := json.NewDecoder(r.Body).Decode(&ru); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		ru.ID = path
		ru.TenantID = tenantID.String()
		if err := h.repo.Save(r.Context(), ru); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, ru)
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
