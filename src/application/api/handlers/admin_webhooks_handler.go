package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AdminWebhooksHandler — CRUD over webhook_subscriptions.
//
//   GET    /api/v1/admin/webhooks
//   POST   /api/v1/admin/webhooks            { target_url, events:[...] }
//   PUT    /api/v1/admin/webhooks/{id}       toggle is_active / change events
//   DELETE /api/v1/admin/webhooks/{id}
//   GET    /api/v1/admin/webhooks/deliveries  recent attempts (audit)
//
// Secrets are generated server-side. The response on POST returns the
// secret exactly once — clients must persist it.
type AdminWebhooksHandler struct {
	pool *pgxpool.Pool
}

func NewAdminWebhooksHandler(pool *pgxpool.Pool) *AdminWebhooksHandler {
	return &AdminWebhooksHandler{pool: pool}
}

func (h *AdminWebhooksHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/webhooks"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		h.list(w, r, tenantID.String())
	case path == "" && r.Method == http.MethodPost:
		h.create(w, r, tenantID.String())
	case path == "deliveries" && r.Method == http.MethodGet:
		h.deliveries(w, r, tenantID.String())
	case r.Method == http.MethodPut || r.Method == http.MethodPatch:
		h.update(w, r, path, tenantID.String())
	case r.Method == http.MethodDelete:
		h.delete(w, r, path)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

type webhookView struct {
	ID        string   `json:"id"`
	TargetURL string   `json:"target_url"`
	Events    []string `json:"events"`
	IsActive  bool     `json:"is_active"`
	HasSecret bool     `json:"has_secret"`
}

func (h *AdminWebhooksHandler) list(w http.ResponseWriter, r *http.Request, tenantID string) {
	rows, err := h.pool.Query(r.Context(), `
SELECT id, target_url, events, is_active, secret <> ''
FROM webhook_subscriptions WHERE tenant_id = $1 ORDER BY target_url`, tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	var out []webhookView
	for rows.Next() {
		var v webhookView
		if err := rows.Scan(&v.ID, &v.TargetURL, &v.Events, &v.IsActive, &v.HasSecret); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		out = append(out, v)
	}
	writeJSON(w, http.StatusOK, out)
}

func (h *AdminWebhooksHandler) create(w http.ResponseWriter, r *http.Request, tenantID string) {
	var p struct {
		TargetURL string   `json:"target_url"`
		Events    []string `json:"events"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.TargetURL == "" {
		http.Error(w, "target_url and events required", http.StatusBadRequest)
		return
	}
	if len(p.Events) == 0 {
		p.Events = []string{
			"booking.created", "booking.updated", "booking.cancelled",
			"booking.approved", "booking.rejected", "weather.signal",
		}
	}
	id := uuid.NewString()
	secret := newSecret()
	_, err := h.pool.Exec(r.Context(), `
INSERT INTO webhook_subscriptions (id, tenant_id, target_url, secret, events, is_active)
VALUES ($1, $2, $3, $4, $5, TRUE)`, id, tenantID, p.TargetURL, secret, p.Events)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	// Return the secret EXACTLY ONCE — admin must store it.
	writeJSON(w, http.StatusCreated, map[string]any{
		"id":         id,
		"target_url": p.TargetURL,
		"events":     p.Events,
		"is_active":  true,
		"secret":     secret,
		"note":       "Store this secret now. It will not be shown again.",
	})
}

func (h *AdminWebhooksHandler) update(w http.ResponseWriter, r *http.Request, id, tenantID string) {
	var p struct {
		TargetURL *string  `json:"target_url"`
		Events    []string `json:"events"`
		IsActive  *bool    `json:"is_active"`
	}
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	_, err := h.pool.Exec(r.Context(), `
UPDATE webhook_subscriptions
   SET target_url = COALESCE($3, target_url),
       events = COALESCE($4, events),
       is_active = COALESCE($5, is_active)
 WHERE id = $1 AND tenant_id = $2`,
		id, tenantID, p.TargetURL, asArray(p.Events), p.IsActive)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminWebhooksHandler) delete(w http.ResponseWriter, r *http.Request, id string) {
	_, err := h.pool.Exec(r.Context(), `DELETE FROM webhook_subscriptions WHERE id = $1`, id)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *AdminWebhooksHandler) deliveries(w http.ResponseWriter, r *http.Request, tenantID string) {
	rows, err := h.pool.Query(r.Context(), `
SELECT d.id, d.subscription_id, d.event, d.attempt_count, d.last_status, COALESCE(d.last_error,''),
       d.delivered_at, d.created_at, s.target_url
FROM webhook_deliveries d
JOIN webhook_subscriptions s ON s.id = d.subscription_id
WHERE d.tenant_id = $1
ORDER BY d.created_at DESC LIMIT 100`, tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	type item struct {
		ID, SubscriptionID, Event, LastError, TargetURL string
		AttemptCount, LastStatus                        int
		DeliveredAt, CreatedAt                          interface{}
	}
	var out []map[string]any
	for rows.Next() {
		var it item
		var lastStatus *int
		if err := rows.Scan(&it.ID, &it.SubscriptionID, &it.Event, &it.AttemptCount,
			&lastStatus, &it.LastError, &it.DeliveredAt, &it.CreatedAt, &it.TargetURL); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		ls := 0
		if lastStatus != nil {
			ls = *lastStatus
		}
		out = append(out, map[string]any{
			"id":              it.ID,
			"subscription_id": it.SubscriptionID,
			"target_url":      it.TargetURL,
			"event":           it.Event,
			"attempt_count":   it.AttemptCount,
			"last_status":     ls,
			"last_error":      it.LastError,
			"delivered_at":    it.DeliveredAt,
			"created_at":      it.CreatedAt,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

// asArray returns nil if the slice is empty so COALESCE leaves the
// existing column value untouched.
func asArray(s []string) interface{} {
	if len(s) == 0 {
		return nil
	}
	return s
}

func newSecret() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return "whsec_" + hex.EncodeToString(b)
}
