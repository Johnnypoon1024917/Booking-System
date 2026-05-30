// Visitor management — invite, check-in, check-out, list.
//
//	GET    /api/v1/visits                       host: my upcoming visitors
//	POST   /api/v1/visits                       host: pre-register a visitor
//	GET    /api/v1/visits/{id}                  host or reception: detail
//	DELETE /api/v1/visits/{id}                  host: cancel a pending visit
//	POST   /api/v1/visits/{id}/checkin          reception: mark arrived
//	POST   /api/v1/visits/{id}/checkout         reception: mark left
//	GET    /api/v1/admin/visits                 reception dashboard (today)
//	POST   /api/v1/checkin/visit/{token}        kiosk QR redemption
//
// Tokens for QR check-in are 32-byte URL-safe random strings, stored
// as sha256 hex digests so the table never contains the plaintext. The
// token TTL defaults to (expected_at + 12h) so a no-show window still
// lets reception mark arrival on a late guest.
package handlers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/visitor"
	"fsd-mrbs/src/infrastructure/auditlog"

	"github.com/google/uuid"
)

type VisitorHandler struct {
	repo visitor.Repository
}

func NewVisitorHandler(r visitor.Repository) *VisitorHandler {
	return &VisitorHandler{repo: r}
}

// ----- host-facing endpoints -----

func (h *VisitorHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/visits")
	rest = strings.Trim(rest, "/")
	switch {
	case rest == "" && r.Method == http.MethodGet:
		h.listForHost(w, r)
	case rest == "" && r.Method == http.MethodPost:
		h.create(w, r)
	case strings.HasSuffix(rest, "/checkin"):
		h.checkin(w, r, strings.TrimSuffix(rest, "/checkin"))
	case strings.HasSuffix(rest, "/checkout"):
		h.checkout(w, r, strings.TrimSuffix(rest, "/checkout"))
	case r.Method == http.MethodGet:
		h.detail(w, r, rest)
	case r.Method == http.MethodDelete:
		h.cancel(w, r, rest)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *VisitorHandler) listForHost(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	from := time.Now().Add(-24 * time.Hour)
	to := time.Now().Add(30 * 24 * time.Hour)
	visits, err := h.repo.ListForHost(r.Context(), tid.String(), uid, from, to)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, visits)
}

func (h *VisitorHandler) create(w http.ResponseWriter, r *http.Request) {
	uid, _ := r.Context().Value("userID").(string)
	tid, ok := tenantIDFromCtx(r)
	if uid == "" || !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var body struct {
		BookingID       string                 `json:"booking_id"`
		VisitorName     string                 `json:"visitor_name"`
		VisitorEmail    string                 `json:"visitor_email"`
		VisitorPhone    string                 `json:"visitor_phone"`
		VisitorCompany  string                 `json:"visitor_company"`
		VisitorIDType   string                 `json:"visitor_id_type"`
		VisitorIDLast4  string                 `json:"visitor_id_last4"`
		Purpose         string                 `json:"purpose"`
		ExpectedAt      string                 `json:"expected_at"`
		ExpectedUntil   string                 `json:"expected_until"`
		HealthDecl      map[string]interface{} `json:"health_declaration"`
		NDAAccepted     bool                   `json:"nda_accepted"`
		Notes           string                 `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.VisitorName == "" || body.ExpectedAt == "" {
		http.Error(w, "visitor_name and expected_at required", http.StatusBadRequest)
		return
	}
	expectedAt, err := time.Parse(time.RFC3339, body.ExpectedAt)
	if err != nil {
		http.Error(w, "expected_at must be RFC3339", http.StatusBadRequest)
		return
	}
	var expectedUntil *time.Time
	if body.ExpectedUntil != "" {
		if t, err := time.Parse(time.RFC3339, body.ExpectedUntil); err == nil {
			expectedUntil = &t
		}
	}

	rawToken, hashed, expiry := mintVisitToken(expectedAt)
	v := visitor.Visit{
		ID:                uuid.NewString(),
		TenantID:          tid.String(),
		BookingID:         body.BookingID,
		HostUserID:        uid,
		VisitorName:       body.VisitorName,
		VisitorEmail:      body.VisitorEmail,
		VisitorPhone:      body.VisitorPhone,
		VisitorCompany:    body.VisitorCompany,
		VisitorIDType:     body.VisitorIDType,
		VisitorIDLast4:    body.VisitorIDLast4,
		Purpose:           body.Purpose,
		ExpectedAt:        expectedAt,
		ExpectedUntil:     expectedUntil,
		Status:            visitor.StatusExpected,
		HealthDeclaration: body.HealthDecl,
		NDAAccepted:       body.NDAAccepted,
		Notes:             body.Notes,
		TokenHash:         hashed,
		TokenExpiresAt:    &expiry,
		CreatedBy:         uid,
		CreatedAt:         time.Now().UTC(),
		UpdatedAt:         time.Now().UTC(),
	}
	if err := h.repo.Save(r.Context(), v); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "VISIT_INVITED",
		TargetEntity: "visit",
		TargetID:     v.ID,
		Next:         map[string]interface{}{"name_hash": shortHash(body.VisitorName), "expected_at": expectedAt},
	})
	// The plaintext token is returned ONCE so the host can share it
	// (email/QR/SMS). It never appears in subsequent reads.
	writeJSON(w, http.StatusCreated, map[string]any{
		"visit":   v,
		"token":   rawToken,
		"qr_url":  "/api/v1/checkin/visit/" + rawToken,
	})
}

func (h *VisitorHandler) detail(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	v, err := h.repo.FindByID(r.Context(), tid.String(), id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	// Strip the token hash before returning — even hashed it is sensitive.
	v.TokenHash = ""
	writeJSON(w, http.StatusOK, v)
}

func (h *VisitorHandler) cancel(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	if err := h.repo.UpdateStatus(r.Context(), tid.String(), id, visitor.StatusCancelled, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{Action: "VISIT_CANCELLED", TargetEntity: "visit", TargetID: id})
	w.WriteHeader(http.StatusNoContent)
}

func (h *VisitorHandler) checkin(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	if err := h.repo.UpdateStatus(r.Context(), tid.String(), id, visitor.StatusCheckedIn, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{Action: "VISIT_CHECKED_IN", TargetEntity: "visit", TargetID: id})
	w.WriteHeader(http.StatusNoContent)
}

func (h *VisitorHandler) checkout(w http.ResponseWriter, r *http.Request, id string) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	if err := h.repo.UpdateStatus(r.Context(), tid.String(), id, visitor.StatusCheckedOut, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{Action: "VISIT_CHECKED_OUT", TargetEntity: "visit", TargetID: id})
	w.WriteHeader(http.StatusNoContent)
}

// ----- reception dashboard -----

func (h *VisitorHandler) AdminToday(w http.ResponseWriter, r *http.Request) {
	tid, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	now := time.Now()
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	to := from.Add(24 * time.Hour)
	visits, err := h.repo.ListForTenant(r.Context(), tid.String(), from, to, r.URL.Query().Get("status"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	for i := range visits {
		visits[i].TokenHash = ""
	}
	writeJSON(w, http.StatusOK, visits)
}

// ----- public kiosk redemption -----

// RedeemKioskToken consumes a one-shot QR token at /api/v1/checkin/visit/<token>.
// Reception scans the QR (which encodes the URL); the server verifies
// the token, flips status to Checked In, and returns the minimal
// reception view (name, host, expected time). The token is NOT
// invalidated on a successful checkin — checkout still uses the same
// token — but is rejected after token_expires_at.
func (h *VisitorHandler) RedeemKioskToken(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token := strings.TrimPrefix(r.URL.Path, "/api/v1/checkin/visit/")
	token = strings.Trim(token, "/")
	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	hashed := sha256hex(token)
	v, err := h.repo.FindByTokenHash(r.Context(), hashed)
	if err != nil || v == nil {
		http.Error(w, "unknown token", http.StatusNotFound)
		return
	}
	if v.TokenExpiresAt != nil && time.Now().After(*v.TokenExpiresAt) {
		http.Error(w, "token expired", http.StatusGone)
		return
	}
	// Toggle: first redemption -> Checked In; second redemption -> Checked Out.
	next := visitor.StatusCheckedIn
	if v.Status == visitor.StatusCheckedIn {
		next = visitor.StatusCheckedOut
	}
	if err := h.repo.UpdateStatus(r.Context(), v.TenantID, v.ID, next, time.Now()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "VISIT_KIOSK_REDEEM",
		TargetEntity: "visit",
		TargetID:     v.ID,
		Next:         map[string]interface{}{"new_status": next},
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"id":           v.ID,
		"visitor_name": v.VisitorName,
		"status":       next,
		"expected_at":  v.ExpectedAt,
	})
}

// ----- helpers -----

func mintVisitToken(expectedAt time.Time) (raw, hashed string, expires time.Time) {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	raw = base64.RawURLEncoding.EncodeToString(b)
	hashed = sha256hex(raw)
	expires = expectedAt.Add(12 * time.Hour)
	return
}

func sha256hex(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func shortHash(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:6])
}

// Errors exposed for tests.
var (
	ErrNoVisitToken = errors.New("no visit token")
)
