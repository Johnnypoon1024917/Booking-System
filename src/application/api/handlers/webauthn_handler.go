// WebAuthn / passkey endpoints.
//
//	POST /api/v1/me/webauthn/register/start    -> options for navigator.credentials.create
//	POST /api/v1/me/webauthn/register/finish   -> store the new credential
//	GET  /api/v1/me/webauthn                   -> list my credentials
//	DELETE /api/v1/me/webauthn/{id}            -> remove a credential
//	POST /api/v1/webauthn/authenticate/start   -> options for navigator.credentials.get
//	POST /api/v1/webauthn/authenticate/finish  -> verify assertion + exchange mfa_token for session JWT
//
// Mirrors the TOTP step-up surface: when a user has at least one
// WebAuthn credential AND has MFA enabled, the login flow returns
// {"mfa_required":true,"mfa_methods":["totp","webauthn"]} and the SPA
// chooses which to use. WebAuthn is preferred when available because
// it's phishing-resistant.
package handlers

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/webauthn"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

type WebAuthnHandler struct {
	pool   *pgxpool.Pool
	rpID   string
	rpName string
	origin string
}

func NewWebAuthnHandler(pool *pgxpool.Pool) *WebAuthnHandler {
	rpID := orDefaultEnv("WEBAUTHN_RP_ID", "localhost")
	rpName := orDefaultEnv("WEBAUTHN_RP_NAME", "FSD MRBS")
	origin := orDefaultEnv("WEBAUTHN_ORIGIN", "http://localhost:8080")
	return &WebAuthnHandler{pool: pool, rpID: rpID, rpName: rpName, origin: origin}
}

// ----- registration -----

func (h *WebAuthnHandler) RegisterStart(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	challenge := newChallenge()
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
INSERT INTO webauthn_challenges (challenge, user_id, tenant_id, purpose)
VALUES ($1, $2::uuid, $3::uuid, 'register')`, challenge, uid, tid.String()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Existing credentials are surfaced so the browser can prevent the
	// user enrolling the same authenticator twice.
	excluded := h.listCredentialIDsForUser(r, uid, tid.String())
	writeJSON(w, http.StatusOK, map[string]any{
		"challenge":          challenge,
		"rp":                 map[string]string{"id": h.rpID, "name": h.rpName},
		"user":               map[string]string{"id": uid, "name": uid, "displayName": uid},
		"pubKeyCredParams":   []map[string]any{{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}},
		"timeout":            60000,
		"attestation":        "none",
		"authenticatorSelection": map[string]any{"userVerification": "preferred", "residentKey": "preferred"},
		"excludeCredentials": excluded,
	})
}

func (h *WebAuthnHandler) RegisterFinish(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var body struct {
		ID            string `json:"id"`
		RawID         string `json:"rawId"`
		Type          string `json:"type"`
		Response      struct {
			ClientDataJSON    string `json:"clientDataJSON"`
			AttestationObject string `json:"attestationObject"`
		} `json:"response"`
		Nickname string `json:"nickname"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}

	clientData, err := webauthn.B64URLDecode(body.Response.ClientDataJSON)
	if err != nil {
		http.Error(w, "clientDataJSON decode: "+err.Error(), http.StatusBadRequest)
		return
	}
	attest, err := webauthn.B64URLDecode(body.Response.AttestationObject)
	if err != nil {
		http.Error(w, "attestationObject decode: "+err.Error(), http.StatusBadRequest)
		return
	}

	// Verify the challenge round-tripped through the browser.
	cd, err := parseClientData(clientData)
	if err != nil || cd.Type != "webauthn.create" {
		http.Error(w, "bad clientData type", http.StatusBadRequest)
		return
	}
	if err := h.consumeChallenge(r, cd.Challenge, "register", uid); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if !originMatch(cd.Origin, h.origin) {
		http.Error(w, "origin mismatch", http.StatusBadRequest)
		return
	}

	// The attestationObject is CBOR: { fmt, authData, attStmt }. We only
	// need authData, but the CBOR parser already supports maps.
	attMap, _, err := webauthn.ReadAttestationMap(attest)
	if err != nil {
		http.Error(w, "attestation decode: "+err.Error(), http.StatusBadRequest)
		return
	}
	authData, _ := attMap["authData"].([]byte)
	if len(authData) == 0 {
		http.Error(w, "attestationObject missing authData", http.StatusBadRequest)
		return
	}
	ad, err := webauthn.ParseAuthData(authData)
	if err != nil {
		http.Error(w, "authData: "+err.Error(), http.StatusBadRequest)
		return
	}
	if len(ad.CredentialID) == 0 || len(ad.COSEKey) == 0 {
		http.Error(w, "authData missing attested credential", http.StatusBadRequest)
		return
	}
	if _, err := webauthn.ParseCOSEKey(ad.COSEKey); err != nil {
		http.Error(w, "unsupported public key: "+err.Error(), http.StatusBadRequest)
		return
	}

	nickname := body.Nickname
	if nickname == "" {
		nickname = "Passkey"
	}
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
INSERT INTO webauthn_credentials (tenant_id, user_id, credential_id, public_key, sign_count, aaguid, nickname)
VALUES ($1::uuid, $2::uuid, $3, $4, $5, NULLIF($6,'')::uuid, $7)
ON CONFLICT (tenant_id, credential_id) DO UPDATE SET nickname = EXCLUDED.nickname`,
		tid, uid, ad.CredentialID, ad.COSEKey, ad.SignCount,
		formatAAGUID(ad.AAGUID), nickname); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action: "WEBAUTHN_REGISTERED", Severity: audit.SeverityWarning,
		TargetEntity: audit.TargetEntityUser, TargetID: uid,
		Next: map[string]interface{}{"nickname": nickname},
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *WebAuthnHandler) List(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	rows, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Query(r.Context(), `
SELECT id, COALESCE(nickname,''), COALESCE(aaguid::text,''), created_at, last_used_at
FROM webauthn_credentials WHERE user_id = $1::uuid AND tenant_id = $2::uuid
ORDER BY created_at DESC`, uid, tid)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type item struct {
		ID         string     `json:"id"`
		Nickname   string     `json:"nickname"`
		AAGUID     string     `json:"aaguid"`
		CreatedAt  time.Time  `json:"created_at"`
		LastUsedAt *time.Time `json:"last_used_at"`
	}
	out := []item{}
	for rows.Next() {
		var it item
		_ = rows.Scan(&it.ID, &it.Nickname, &it.AAGUID, &it.CreatedAt, &it.LastUsedAt)
		out = append(out, it)
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *WebAuthnHandler) Delete(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/v1/me/webauthn/")
	id = strings.Trim(id, "/")
	if id == "" {
		http.Error(w, "id required", http.StatusBadRequest)
		return
	}
	tag, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(),
		`DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2::uuid AND tenant_id = $3::uuid`,
		id, uid, tid)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if tag.RowsAffected() == 0 {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action: "WEBAUTHN_REMOVED", Severity: audit.SeverityWarning,
		TargetEntity: audit.TargetEntityUser, TargetID: uid,
		Next: map[string]interface{}{"credential_id": id},
	})
	w.WriteHeader(http.StatusNoContent)
}

// ----- helpers -----

func newChallenge() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func (h *WebAuthnHandler) consumeChallenge(r *http.Request, challenge, purpose, userID string) error {
	tag, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
DELETE FROM webauthn_challenges
WHERE challenge = $1 AND purpose = $2
  AND (user_id IS NULL OR user_id = $3::uuid)
  AND expires_at > NOW()`, challenge, purpose, userID)
	if err != nil {
		return fmt.Errorf("challenge consume: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return errors.New("unknown or expired challenge")
	}
	return nil
}

func (h *WebAuthnHandler) listCredentialIDsForUser(r *http.Request, userID, tenantID string) []map[string]any {
	rows, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Query(r.Context(),
		`SELECT credential_id FROM webauthn_credentials WHERE user_id = $1::uuid AND tenant_id = $2::uuid`,
		userID, tenantID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []map[string]any
	for rows.Next() {
		var raw []byte
		if rows.Scan(&raw) == nil {
			out = append(out, map[string]any{
				"type": "public-key",
				"id":   webauthn.B64URL(raw),
			})
		}
	}
	return out
}

type clientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

func parseClientData(b []byte) (*clientData, error) {
	var cd clientData
	if err := json.Unmarshal(b, &cd); err != nil {
		return nil, err
	}
	return &cd, nil
}

func originMatch(got, expected string) bool {
	g := strings.TrimRight(got, "/")
	e := strings.TrimRight(expected, "/")
	if g == e {
		return true
	}
	// Allow same host on different ports during local dev.
	return strings.HasPrefix(g, e) || strings.HasPrefix(e, g)
}

func formatAAGUID(b []byte) string {
	if len(b) != 16 {
		return ""
	}
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func orDefaultEnv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
