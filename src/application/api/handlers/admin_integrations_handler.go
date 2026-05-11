package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/integration"
	infraint "fsd-mrbs/src/infrastructure/integration"
)

// detached returns a fresh context for fire-and-forget background calls
// triggered from request handlers. Using r.Context() directly would
// cancel the call as soon as the response is flushed.
func detached() context.Context {
	ctx, _ := context.WithTimeout(context.Background(), 30*time.Second)
	return ctx
}

// AdminIntegrationsHandler — CRUD over integration_credentials and the
// resource ↔ mailbox map, plus a "test connection" endpoint.
//
//   GET    /api/v1/admin/integrations                    list providers configured
//   PUT    /api/v1/admin/integrations/{provider}         create / update
//   DELETE /api/v1/admin/integrations/{provider}         delete
//   POST   /api/v1/admin/integrations/{provider}/test    test the credentials live
//
//   GET    /api/v1/admin/integrations/mailboxes          list resource→mailbox mappings (with sub status)
//   PUT    /api/v1/admin/integrations/mailboxes          { resource_id, mailbox_upn, display_name, is_active }
//   DELETE /api/v1/admin/integrations/mailboxes/{rid}    remove a mapping
//
// SubscriptionLifecycle is an injected closure that knows how to call the
// ManageGraphSubscriptionsUseCase without us depending on the usecase
// package directly.
type AdminIntegrationsHandler struct {
	creds         integration.CredentialRepository
	mailboxes     integration.MailboxRepository
	graph         *infraint.GraphClient
	onMailboxMap  func(ctx interface{ Done() <-chan struct{} }, tenantID, mailboxUPN string)
	onMailboxDel  func(ctx interface{ Done() <-chan struct{} }, tenantID, mailboxUPN string)
}

func NewAdminIntegrationsHandler(
	creds integration.CredentialRepository,
	mailboxes integration.MailboxRepository,
	graph *infraint.GraphClient,
) *AdminIntegrationsHandler {
	return &AdminIntegrationsHandler{creds: creds, mailboxes: mailboxes, graph: graph}
}

// WithSubscriptionLifecycle attaches hooks called on mailbox map / unmap.
// The lifecycle manager is in the usecase package; we accept it as
// closures to avoid an import cycle.
func (h *AdminIntegrationsHandler) WithSubscriptionLifecycle(
	onAdd, onRemove func(ctx interface{ Done() <-chan struct{} }, tenantID, mailboxUPN string),
) *AdminIntegrationsHandler {
	h.onMailboxMap = onAdd
	h.onMailboxDel = onRemove
	return h
}

func (h *AdminIntegrationsHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/integrations"), "/")
	parts := strings.Split(path, "/")

	// /mailboxes ...
	if parts[0] == "mailboxes" {
		h.dispatchMailboxes(w, r, tenantID.String(), parts[1:])
		return
	}

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.creds.List(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)

	case len(parts) == 1 && (r.Method == http.MethodPut || r.Method == http.MethodPost):
		var p integration.Credential
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
			http.Error(w, "invalid payload", http.StatusBadRequest)
			return
		}
		p.TenantID = tenantID.String()
		p.Provider = parts[0]
		p.IsActive = true
		if err := h.creds.Save(r.Context(), p); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case len(parts) == 1 && r.Method == http.MethodDelete:
		if err := h.creds.Delete(r.Context(), tenantID.String(), parts[0]); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)

	case len(parts) == 2 && parts[1] == "test" && r.Method == http.MethodPost:
		h.test(w, r, tenantID.String(), parts[0])

	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

func (h *AdminIntegrationsHandler) test(w http.ResponseWriter, r *http.Request, tenantID, provider string) {
	if provider != integration.ProviderMicrosoft {
		http.Error(w, "live test only supported for microsoft", http.StatusBadRequest)
		return
	}
	cred, err := h.creds.Get(r.Context(), tenantID, provider)
	if err != nil {
		http.Error(w, "credentials not configured", http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	tErr := h.graph.TestConnection(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret)
	ok := tErr == nil
	msg := ""
	if !ok {
		msg = tErr.Error()
	}
	_ = h.creds.UpdateTestResult(r.Context(), tenantID, provider, ok, msg)
	if !ok {
		writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *AdminIntegrationsHandler) dispatchMailboxes(w http.ResponseWriter, r *http.Request, tenantID string, parts []string) {
	switch {
	case (len(parts) == 0 || parts[0] == "") && r.Method == http.MethodGet:
		out, err := h.mailboxes.List(r.Context(), tenantID)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case (len(parts) == 0 || parts[0] == "") && (r.Method == http.MethodPut || r.Method == http.MethodPost):
		var p integration.RoomMailbox
		if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.ResourceID == "" || p.MailboxUPN == "" {
			http.Error(w, "resource_id + mailbox_upn required", http.StatusBadRequest)
			return
		}
		p.TenantID = tenantID
		p.IsActive = true
		if err := h.mailboxes.Save(r.Context(), p); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		// Best-effort: kick off Graph subscription create / renew. Failures
		// here don't block the mapping save — the scheduler will retry.
		if h.onMailboxMap != nil {
			go h.onMailboxMap(detached(), tenantID, p.MailboxUPN)
		}
		w.WriteHeader(http.StatusNoContent)
	case len(parts) == 1 && r.Method == http.MethodDelete:
		// Look up the mailbox UPN before delete so we can tell Graph to
		// drop the subscription afterwards.
		var mailboxUPN string
		if existing, _ := h.mailboxes.GetByResource(r.Context(), parts[0]); existing != nil {
			mailboxUPN = existing.MailboxUPN
		}
		if err := h.mailboxes.Delete(r.Context(), parts[0]); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if h.onMailboxDel != nil && mailboxUPN != "" {
			go h.onMailboxDel(detached(), tenantID, mailboxUPN)
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}
