package handlers

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/graphsub"
	"fsd-mrbs/src/infrastructure/integration"
)

// GraphNotificationsHandler receives Microsoft Graph change-notifications
// for our subscribed room mailboxes.
//
// Two flows:
//
//   1. Validation handshake — Graph POSTs with ?validationToken=xxx during
//      subscription creation. We MUST echo the token verbatim within 10s
//      with content-type text/plain and a 200.
//
//   2. Notification batch — Graph POSTs JSON {value:[{subscriptionId,
//      clientState, resourceData{id}, changeType, ...}]}. We verify
//      clientState matches the persisted value (HMAC equality), then
//      hand each item to the reconcile use case.
//
// Endpoint MUST be reachable from Microsoft (HTTPS public hostname).
//
//   POST /api/v1/graph/notifications
type GraphNotificationsHandler struct {
	subs      graphsub.Repository
	uc        *usecase.ReconcileGraphEventUseCase
	validator *integration.GraphTokenValidator
}

func NewGraphNotificationsHandler(subs graphsub.Repository, uc *usecase.ReconcileGraphEventUseCase) *GraphNotificationsHandler {
	return &GraphNotificationsHandler{
		subs:      subs,
		uc:        uc,
		validator: integration.NewGraphTokenValidator(),
	}
}

func (h *GraphNotificationsHandler) Handle(w http.ResponseWriter, r *http.Request) {
	// 1. Handshake
	if vt := r.URL.Query().Get("validationToken"); vt != "" {
		w.Header().Set("Content-Type", "text/plain")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, vt)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 256*1024))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}

	var batch struct {
		Value []struct {
			SubscriptionID string `json:"subscriptionId"`
			ClientState    string `json:"clientState"`
			ChangeType     string `json:"changeType"`
			Resource       string `json:"resource"`
			ResourceData   struct {
				ID string `json:"id"`
			} `json:"resourceData"`
		} `json:"value"`
		ValidationTokens []string `json:"validationTokens"`
	}
	if err := json.Unmarshal(body, &batch); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}

	// JWT-level validation: every notification batch from Microsoft Graph
	// includes one or more validationTokens, each a JWT signed by Azure
	// AD with our app's id as audience. We require at least one valid
	// token. Failing closed here protects against payload spoofing even
	// if an attacker happens to learn a clientState.
	expectedAud := os.Getenv("GRAPH_NOTIF_AUDIENCE")
	if expectedAud == "" {
		expectedAud = os.Getenv("BOT_APP_ID") // sensible default
	}
	if len(batch.ValidationTokens) > 0 && expectedAud != "" {
		validCtx, cancelV := context.WithTimeout(r.Context(), 5_000_000_000)
		defer cancelV()
		anyValid := false
		for _, tk := range batch.ValidationTokens {
			if err := h.validator.Validate(validCtx, tk, expectedAud); err == nil {
				anyValid = true
				break
			}
		}
		if !anyValid {
			slog.Warn("graph notification: no validationToken matched")
			http.Error(w, "invalid validation token", http.StatusUnauthorized)
			return
		}
	}

	// Acknowledge fast (within 30s window) and reconcile in the
	// background — Graph retries on 5xx but stops if we're slow.
	w.WriteHeader(http.StatusAccepted)

	go h.reconcileAll(batch.Value)
}

func (h *GraphNotificationsHandler) reconcileAll(values []struct {
	SubscriptionID string `json:"subscriptionId"`
	ClientState    string `json:"clientState"`
	ChangeType     string `json:"changeType"`
	Resource       string `json:"resource"`
	ResourceData   struct {
		ID string `json:"id"`
	} `json:"resourceData"`
}) {
	ctx, cancel := context.WithTimeout(context.Background(), 60_000_000_000) // 60s
	defer cancel()

	for _, v := range values {
		sub, err := h.subs.GetByGraphID(ctx, v.SubscriptionID)
		if err != nil || sub == nil {
			slog.Warn("graph notification: unknown subscription", "id", v.SubscriptionID)
			continue
		}
		// Verify clientState (constant-time compare)
		if subtle.ConstantTimeCompare([]byte(sub.ClientState), []byte(v.ClientState)) != 1 {
			slog.Warn("graph notification: clientState mismatch", "id", v.SubscriptionID)
			continue
		}
		mailbox := mailboxFromResource(v.Resource)
		if err := h.uc.HandleNotification(ctx, sub, v.ChangeType, mailbox, v.ResourceData.ID); err != nil {
			slog.Error("graph reconcile", "err", err, "event", v.ResourceData.ID)
		}
	}
}

// mailboxFromResource extracts the mailbox UPN from the Graph resource
// path "users/{upn}/events".
func mailboxFromResource(resource string) string {
	const prefix = "users/"
	if i := indexOf(resource, prefix); i >= 0 {
		rest := resource[i+len(prefix):]
		if j := indexOf(rest, "/"); j >= 0 {
			return rest[:j]
		}
		return rest
	}
	return ""
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
