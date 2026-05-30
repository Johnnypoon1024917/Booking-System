// TOTP MFA endpoints (NIST IA-2(1)).
//
//	GET    /api/v1/me/mfa             -> current enrolment state
//	POST   /api/v1/me/mfa/enroll      -> generate secret, return otpauth URI
//	POST   /api/v1/me/mfa/activate    -> verify first code, flip mfa_enabled
//	DELETE /api/v1/me/mfa             -> disarm (requires a valid code)
//
// The two-step exchange for login (credentials -> mfa_token -> code) lives
// in main.go's loginHandler / mfaVerifyHandler so it can reuse the existing
// AD service. Endpoints here cover enrolment from inside the SPA.
package handlers

import (
	"encoding/json"
	"net/http"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/mfa"
	"fsd-mrbs/src/infrastructure/auditlog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// MFAHandler exposes self-service TOTP enrolment.
type MFAHandler struct {
	pool   *pgxpool.Pool
	issuer string
}

func NewMFAHandler(pool *pgxpool.Pool, issuer string) *MFAHandler {
	if issuer == "" {
		issuer = "FSD MRBS"
	}
	return &MFAHandler{pool: pool, issuer: issuer}
}

func (h *MFAHandler) Status(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var enabled bool
	_ = h.pool.QueryRow(r.Context(),
		`SELECT COALESCE(mfa_enabled, FALSE) FROM users WHERE id = $1 AND tenant_id = $2`,
		uid, tid).Scan(&enabled)
	writeJSON(w, http.StatusOK, map[string]any{"enabled": enabled})
}

// Enroll generates a new TOTP secret and stores it as pending (mfa_enabled
// stays FALSE until the user verifies a code with Activate). The response
// returns the otpauth:// URI for QR rendering. Re-enrolling overwrites the
// pending secret — admin-confirmed loss of device is a separate flow.
func (h *MFAHandler) Enroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	username, _ := r.Context().Value("username").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	if username == "" {
		_ = h.pool.QueryRow(r.Context(),
			`SELECT COALESCE(username,'') FROM users WHERE id = $1`, uid).Scan(&username)
	}
	secret, err := mfa.GenerateSecret()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if _, err := h.pool.Exec(r.Context(),
		`UPDATE users SET mfa_secret = $3 WHERE id = $1 AND tenant_id = $2`,
		uid, tid, secret); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"secret":      secret,
		"otpauth_url": mfa.OtpauthURL(h.issuer, username, secret),
	})
}

// Activate verifies the user-provided code against the pending secret and,
// on success, flips mfa_enabled and stamps mfa_enrolled_at.
func (h *MFAHandler) Activate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Code == "" {
		http.Error(w, "code required", http.StatusBadRequest)
		return
	}
	var secret string
	if err := h.pool.QueryRow(r.Context(),
		`SELECT COALESCE(mfa_secret,'') FROM users WHERE id = $1 AND tenant_id = $2`,
		uid, tid).Scan(&secret); err != nil || secret == "" {
		http.Error(w, "no pending enrolment; call /enroll first", http.StatusBadRequest)
		return
	}
	ok2, err := mfa.Verify(secret, body.Code)
	if err != nil || !ok2 {
		auditlog.Denied(r, "MFA_ACTIVATE", audit.TargetEntityUser, uid, "bad code")
		http.Error(w, "invalid code", http.StatusUnauthorized)
		return
	}
	if _, err := h.pool.Exec(r.Context(),
		`UPDATE users
		    SET mfa_enabled = TRUE, mfa_enrolled_at = NOW()
		  WHERE id = $1 AND tenant_id = $2`, uid, tid); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "MFA_ACTIVATE",
		Severity:     audit.SeverityWarning,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
		Next:         map[string]interface{}{"method": "totp"},
	})
	w.WriteHeader(http.StatusNoContent)
}

// Disarm turns off MFA after verifying a fresh code. Admin-side disarm
// (for lost-device recovery) belongs in admin_user_handler.go and emits
// a separate audit action.
func (h *MFAHandler) Disarm(w http.ResponseWriter, r *http.Request) {
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
	var body struct {
		Code string `json:"code"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	var secret string
	if err := h.pool.QueryRow(r.Context(),
		`SELECT COALESCE(mfa_secret,'') FROM users WHERE id = $1 AND tenant_id = $2`,
		uid, tid).Scan(&secret); err != nil || secret == "" {
		http.Error(w, "mfa not enrolled", http.StatusConflict)
		return
	}
	ok2, _ := mfa.Verify(secret, body.Code)
	if !ok2 {
		auditlog.Denied(r, "MFA_DISARM", audit.TargetEntityUser, uid, "bad code")
		http.Error(w, "invalid code", http.StatusUnauthorized)
		return
	}
	if _, err := h.pool.Exec(r.Context(),
		`UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL, mfa_enrolled_at = NULL
		  WHERE id = $1 AND tenant_id = $2`, uid, tid); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "MFA_DISARM",
		Severity:     audit.SeverityWarning,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
	})
	w.WriteHeader(http.StatusNoContent)
}
