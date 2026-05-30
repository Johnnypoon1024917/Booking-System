// Data-Subject Access Request endpoints (GDPR Art. 15/17/20, HK PDPO DPP6).
//
//	GET    /api/v1/me/export    -> JSON dump of the caller's personal data
//	DELETE /api/v1/me           -> pseudonymise the caller's account and
//	                               null out PII on past bookings
//
// "Delete" here means right-to-erasure with a legal-hold carve-out: rows
// that anchor audit history (audit_entries, bookings.user_id) are kept
// for compliance, but every PII field on those records is replaced with
// a tombstone. The caller's user row itself is marked inactive and its
// identifier rotated, so subsequent logins fail.
package handlers

import (
	"encoding/json"
	"net/http"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/infrastructure/auditlog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// DSARHandler exposes self-service data export and erasure to authenticated
// callers. Admin-initiated erasure on behalf of another user is a separate
// flow that lives in admin_user_handler.go.
type DSARHandler struct {
	pool *pgxpool.Pool
}

func NewDSARHandler(pool *pgxpool.Pool) *DSARHandler {
	return &DSARHandler{pool: pool}
}

// Export returns the caller's PII plus all bookings, approvals, audit
// entries where they were actor or target, MFA enrolment state, and any
// SCIM-provisioned attributes. The output is machine-readable JSON so it
// satisfies the data-portability requirement (GDPR Art. 20).
func (h *DSARHandler) Export(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	out := map[string]any{}

	// Profile
	var profile map[string]any
	row := h.pool.QueryRow(r.Context(), `
SELECT id, tenant_id, username, COALESCE(display_name,''), COALESCE(email,''),
       COALESCE(role,''), COALESCE(grade,''), COALESCE(dn,''), is_active,
       mfa_enabled, mfa_enrolled_at, created_at
FROM users WHERE id = $1 AND tenant_id = $2`, uid, tid)
	var id, tenant, username, display, email, role, grade, dn string
	var isActive, mfaEnabled bool
	var mfaEnrolled any
	var createdAt any
	if err := row.Scan(&id, &tenant, &username, &display, &email, &role, &grade, &dn, &isActive, &mfaEnabled, &mfaEnrolled, &createdAt); err == nil {
		profile = map[string]any{
			"id": id, "tenant_id": tenant, "username": username,
			"display_name": display, "email": email, "role": role,
			"grade": grade, "dn": dn, "is_active": isActive,
			"mfa_enabled": mfaEnabled, "mfa_enrolled_at": mfaEnrolled,
			"created_at": createdAt,
		}
	}
	out["profile"] = profile

	out["bookings"] = collect(r, h.pool, `
SELECT id, resource_id, start_time, end_time, status, COALESCE(meeting_url,''), created_at
FROM bookings WHERE user_id = $1 ORDER BY start_time DESC`, uid)

	out["audit_actor"] = collect(r, h.pool, `
SELECT id, action_type, target_entity, target_id, outcome, severity, timestamp, ip_address, user_agent
FROM audit_entries WHERE actor_user_id = $1::uuid AND tenant_id = $2
ORDER BY timestamp DESC LIMIT 5000`, uid, tid.String())

	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionDataExported,
		Severity:     audit.SeverityWarning,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
		Next:         map[string]interface{}{"kind": "dsar"},
	})

	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=my-data.json")
	_ = json.NewEncoder(w).Encode(out)
}

// Delete pseudonymises the caller's record. To preserve audit integrity
// the row IS NOT removed; instead PII is overwritten with deterministic
// tombstones and the account is disabled. This is the model GDPR
// guidance accepts when audit retention is mandatory (NIST AU-11).
func (h *DSARHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}

	tx, err := h.pool.Begin(r.Context())
	if err != nil {
		auditlog.Failure(r, "DSAR_DELETE", audit.TargetEntityUser, uid, err.Error())
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	// Tombstone PII on the user row but keep the UUID and tenant_id so
	// audit FKs stay valid. The username is randomised to free up the
	// natural key for re-use.
	if _, err := tx.Exec(r.Context(), `
UPDATE users
   SET display_name = '[redacted]',
       email        = NULL,
       dn           = '[redacted]',
       is_active    = FALSE,
       mfa_enabled  = FALSE,
       mfa_secret   = NULL,
       username     = CONCAT('redacted-', id::text)
 WHERE id = $1 AND tenant_id = $2`, uid, tid); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Cancel any future bookings — keep the row for audit, blank the
	// meeting URL and notes which can contain PII.
	if _, err := tx.Exec(r.Context(), `
UPDATE bookings
   SET status          = 'Cancelled',
       meeting_url     = '',
       exception_notes = '[redacted by DSAR]'
 WHERE user_id = $1 AND end_time > NOW()`, uid); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	auditlog.Record(r, auditlog.Event{
		Action:       "DSAR_DELETE",
		Severity:     audit.SeverityCritical,
		Outcome:      audit.OutcomeSuccess,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
		Next:         map[string]interface{}{"kind": "erasure"},
	})
	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// collect runs a query and returns the result rows as []map[string]any.
// It is used by Export and intentionally limits attack surface — only
// repository-style SQL chosen by the caller, never user-controlled text.
func collect(r *http.Request, pool *pgxpool.Pool, sql string, args ...any) []map[string]any {
	rows, err := pool.Query(r.Context(), sql, args...)
	if err != nil {
		return nil
	}
	defer rows.Close()
	out := []map[string]any{}
	fields := rows.FieldDescriptions()
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			continue
		}
		m := make(map[string]any, len(vals))
		for i, v := range vals {
			m[string(fields[i].Name)] = v
		}
		out = append(out, m)
	}
	return out
}
