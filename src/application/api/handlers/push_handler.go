// Web Push (W3C Push API + VAPID) endpoints.
//
//	GET    /api/v1/push/vapid-key      -> public application server key
//	POST   /api/v1/me/push             -> register a subscription
//	DELETE /api/v1/me/push             -> unregister (by endpoint)
//
// Sending the actual push payload happens in the notification worker;
// this handler only manages subscriptions. The VAPID private key lives
// in the env (VAPID_PRIVATE_KEY); the worker signs JWTs with it when it
// dispatches a notification. We expose only the public key here so the
// SPA can pass it to `pushManager.subscribe({ applicationServerKey })`.
package handlers

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"strings"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PushHandler struct {
	pool          *pgxpool.Pool
	vapidPublicB64 string
}

func NewPushHandler(pool *pgxpool.Pool) *PushHandler {
	// VAPID_PUBLIC_KEY is the uncompressed P-256 point in base64url form.
	// When unset we still serve the endpoint but with an empty key so the
	// SPA can detect the feature is disabled and hide the toggle.
	return &PushHandler{
		pool:           pool,
		vapidPublicB64: os.Getenv("VAPID_PUBLIC_KEY"),
	}
}

// VapidKey returns the public application server key so the SPA can
// register a push subscription. The key MUST be base64url-encoded
// without padding — the Push API rejects standard base64.
func (h *PushHandler) VapidKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, http.StatusOK, map[string]string{
		"public_key": h.vapidPublicB64,
	})
}

// Subscribe stores the browser-issued PushSubscription. Re-subscribing
// the same endpoint updates the existing row (UNIQUE on user_id+endpoint).
func (h *PushHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
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
		Endpoint string `json:"endpoint"`
		Keys     struct {
			P256dh string `json:"p256dh"`
			Auth   string `json:"auth"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil ||
		body.Endpoint == "" || body.Keys.P256dh == "" || body.Keys.Auth == "" {
		http.Error(w, "endpoint, keys.p256dh, keys.auth required", http.StatusBadRequest)
		return
	}
	// Defensive: reject endpoints whose scheme is anything other than
	// https — Push services all use HTTPS, and accepting http is just an
	// SSRF foothold for the worker.
	if !strings.HasPrefix(body.Endpoint, "https://") {
		http.Error(w, "endpoint must be https", http.StatusBadRequest)
		return
	}
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(), `
INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (user_id, endpoint) DO UPDATE
SET p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    user_agent = EXCLUDED.user_agent,
    last_used_at = NULL`,
		tid, uid, body.Endpoint, body.Keys.P256dh, body.Keys.Auth, r.UserAgent()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "PUSH_SUBSCRIBED",
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
		Next:         map[string]interface{}{"endpoint_hash": endpointHash(body.Endpoint)},
	})
	w.WriteHeader(http.StatusNoContent)
}

// Unsubscribe removes a subscription by endpoint. The endpoint is sent
// in the body so we don't put it in a URL (Push endpoints can be very
// long and may contain query parameters that confuse routers).
func (h *PushHandler) Unsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodDelete {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	uid, _ := r.Context().Value("userID").(string)
	if uid == "" {
		http.Error(w, "auth context missing", http.StatusUnauthorized)
		return
	}
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Endpoint == "" {
		http.Error(w, "endpoint required", http.StatusBadRequest)
		return
	}
	if _, err := dbctx.ExecutorFromContext(r.Context(), h.pool).Exec(r.Context(),
		`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`,
		uid, body.Endpoint); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       "PUSH_UNSUBSCRIBED",
		TargetEntity: audit.TargetEntityUser,
		TargetID:     uid,
		Next:         map[string]interface{}{"endpoint_hash": endpointHash(body.Endpoint)},
	})
	w.WriteHeader(http.StatusNoContent)
}

// endpointHash is a short, stable identifier we can log without leaking
// the full push endpoint URL.
func endpointHash(endpoint string) string {
	sum := sha256.Sum256([]byte(endpoint))
	return base64.RawURLEncoding.EncodeToString(sum[:8])
}
