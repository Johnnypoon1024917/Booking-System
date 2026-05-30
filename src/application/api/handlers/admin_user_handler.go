package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
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
		// Hash an admin-set initial password (if any). Plaintext is never
		// persisted; only the bcrypt hash reaches the repo.
		if u.Password != "" {
			hash, herr := bcrypt.GenerateFromPassword([]byte(u.Password), bcrypt.DefaultCost)
			if herr != nil {
				http.Error(w, "could not hash password", http.StatusInternalServerError)
				return
			}
			u.PasswordHash = string(hash)
			u.Password = ""
		}
		if err := h.repo.Save(r.Context(), u); err != nil {
			auditlog.Failure(r, audit.ActionUserCreated, "user", u.Username, err.Error())
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		// Persist department memberships separately — Save() only
		// writes the users row; the user_departments join table needs
		// its own pass.
		if err := h.repo.SetDepartmentIDs(r.Context(), u.TenantID, u.ID, u.DepartmentIDs); err != nil {
			auditlog.Failure(r, audit.ActionUserCreated, "user", u.ID, "set departments: "+err.Error())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionUserCreated,
			Severity:     audit.SeverityWarning,
			TargetEntity: "user",
			TargetID:     u.ID,
			Next: map[string]interface{}{
				"username":       u.Username,
				"role":           u.Role,
				"grade":          u.Grade,
				"region_access":  u.RegionAccess,
				"department_ids": u.DepartmentIDs,
			},
		})
		writeJSON(w, http.StatusCreated, u)
	case r.Method == http.MethodGet:
		id := path
		got, err := h.repo.GetByID(r.Context(), id)
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}
		// Cross-tenant IDOR guard: GetByID does not filter by tenant
		// (it can't — it's called from login before scope is set).
		// Reject any admin-API read that crosses tenant boundaries.
		if got.TenantID != tenantID.String() {
			http.Error(w, "not found", http.StatusNotFound)
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
		// Same IDOR guard as GET. Without it, an admin in tenant A
		// who guesses a tenant-B user UUID could overwrite the row
		// — and since the handler then forces TenantID = A on the
		// patch, the user would be *moved* into A. 404 on mismatch
		// matches the GET behaviour and avoids leaking existence.
		if existing.TenantID != tenantID.String() {
			http.Error(w, "not found", http.StatusNotFound)
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
		// Re-hash only when the admin supplied a new password; otherwise
		// Save preserves the existing hash (empty PasswordHash → COALESCE).
		if patch.Password != "" {
			hash, herr := bcrypt.GenerateFromPassword([]byte(patch.Password), bcrypt.DefaultCost)
			if herr != nil {
				http.Error(w, "could not hash password", http.StatusInternalServerError)
				return
			}
			patch.PasswordHash = string(hash)
			patch.Password = ""
		}
		if err := h.repo.Save(r.Context(), patch); err != nil {
			auditlog.Failure(r, audit.ActionUserUpdated, "user", patch.ID, err.Error())
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		// Replace department membership iff the client sent the field.
		// PATCH semantics: a missing DepartmentIDs key on the wire
		// deserialises to nil, leaving existing memberships untouched.
		// An explicit empty array (`[]`) clears all memberships.
		if patch.DepartmentIDs != nil {
			if err := h.repo.SetDepartmentIDs(r.Context(), patch.TenantID, patch.ID, patch.DepartmentIDs); err != nil {
				auditlog.Failure(r, audit.ActionUserUpdated, "user", patch.ID, "set departments: "+err.Error())
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		} else {
			// Echo the existing membership back on the response so the
			// SPA doesn't think a PUT wiped them.
			patch.DepartmentIDs = existing.DepartmentIDs
		}
		// Audit the field-level diff. Role changes get their own
		// critical-severity ROLE_CHANGED event so SOC can alert on
		// privilege escalation independently of routine profile edits.
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionUserUpdated,
			Severity:     audit.SeverityWarning,
			TargetEntity: "user",
			TargetID:     patch.ID,
			Previous: map[string]interface{}{
				"role":           existing.Role,
				"grade":          existing.Grade,
				"is_active":      existing.IsActive,
				"region_access":  existing.RegionAccess,
				"department_ids": existing.DepartmentIDs,
				"dn":             existing.DN,
			},
			Next: map[string]interface{}{
				"role":           patch.Role,
				"grade":          patch.Grade,
				"is_active":      patch.IsActive,
				"region_access":  patch.RegionAccess,
				"department_ids": patch.DepartmentIDs,
				"dn":             patch.DN,
			},
		})
		if existing.Role != patch.Role {
			auditlog.Record(r, auditlog.Event{
				Action:       audit.ActionRoleChanged,
				Severity:     audit.SeverityCritical,
				TargetEntity: "user",
				TargetID:     patch.ID,
				Previous:     map[string]interface{}{"role": existing.Role},
				Next:         map[string]interface{}{"role": patch.Role},
			})
		}
		writeJSON(w, http.StatusOK, patch)
	case r.Method == http.MethodDelete:
		// Same cross-tenant IDOR guard as GET/PUT — verify the target
		// user belongs to the caller's tenant before SetActive runs.
		existing, err := h.repo.GetByID(r.Context(), path)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if existing.TenantID != tenantID.String() {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if err := h.repo.SetActive(r.Context(), path, false); err != nil {
			auditlog.Failure(r, audit.ActionUserDeactivated, "user", path, err.Error())
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		auditlog.Record(r, auditlog.Event{
			Action:       audit.ActionUserDeactivated,
			Severity:     audit.SeverityWarning,
			TargetEntity: "user",
			TargetID:     path,
			Previous:     map[string]interface{}{"is_active": existing.IsActive, "username": existing.Username},
			Next:         map[string]interface{}{"is_active": false},
		})
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}
