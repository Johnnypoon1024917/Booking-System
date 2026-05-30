// Federated SSO endpoints.
//
//	GET  /api/v1/auth/oidc/start?tenant=...      -> 302 to IdP
//	GET  /api/v1/auth/oidc/callback              -> exchange + session JWT
//	GET  /api/v1/auth/saml/init?tenant=...       -> 302 to IdP (Redirect binding)
//	POST /api/v1/auth/saml/acs                   -> consume signed response
//
// The flow is tenant-driven: each tenant configures its own provider in
// admin_integrations_handler / tenants.identity_provider_config. The
// handler resolves the provider via auth.ProviderFactory.
//
// In-flight state (nonce, PKCE verifier, RelayState) is persisted in the
// sso_state table so it survives a multi-replica deploy and a retry. The
// retention scheduler sweeps expired rows.
package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/domain/user"
	infauth "fsd-mrbs/src/infrastructure/auth"
	"fsd-mrbs/src/infrastructure/auditlog"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SSOHandler wires the OIDC and SAML providers into HTTP endpoints. It
// depends only on what the providers expose plus enough state to mint the
// session JWT once federation succeeds.
type SSOHandler struct {
	pool           *pgxpool.Pool
	factory        *infauth.ProviderFactory
	userRepo       postgres.UserRepository
	jwtSecret      []byte
	sessionTTL     time.Duration
	defaultTenant  string
	identityConfig func(ctx context.Context, tenantID string) (map[string]interface{}, error)
}

// NewSSOHandler builds the handler. identityConfig is a callback that
// returns the tenant's identity_provider_config JSON; in main.go that
// resolves to tenantRepo.GetByID(...).IdentityProviderConfig so we don't
// pin this handler to a particular repo.
func NewSSOHandler(
	pool *pgxpool.Pool,
	factory *infauth.ProviderFactory,
	userRepo postgres.UserRepository,
	jwtSecret []byte,
	sessionTTL time.Duration,
	defaultTenant string,
	identityConfig func(ctx context.Context, tenantID string) (map[string]interface{}, error),
) *SSOHandler {
	return &SSOHandler{
		pool:           pool,
		factory:        factory,
		userRepo:       userRepo,
		jwtSecret:      jwtSecret,
		sessionTTL:     sessionTTL,
		defaultTenant:  defaultTenant,
		identityConfig: identityConfig,
	}
}

// ---------- OIDC ----------

func (h *SSOHandler) OIDCStart(w http.ResponseWriter, r *http.Request) {
	tenantID := r.URL.Query().Get("tenant")
	if tenantID == "" {
		tenantID = h.defaultTenant
	}
	prov, err := h.oidcProvider(r.Context(), tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	req, err := prov.StartAuthorization()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	redirectAfter := r.URL.Query().Get("redirect")
	if !isSafeRedirect(redirectAfter) {
		redirectAfter = "/app/"
	}
	if _, err := h.pool.Exec(r.Context(), `
INSERT INTO sso_state (state, tenant_id, provider, nonce, verifier, redirect_after)
VALUES ($1, $2::uuid, 'oidc', $3, $4, $5)`,
		req.State, tenantID, req.Nonce, req.Verifier, redirectAfter); err != nil {
		http.Error(w, "state persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, req.URL, http.StatusFound)
}

func (h *SSOHandler) OIDCCallback(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	state := q.Get("state")
	code := q.Get("code")
	if state == "" || code == "" {
		http.Error(w, "missing state or code", http.StatusBadRequest)
		return
	}
	var (
		tenantID, nonce, verifier, redirectAfter string
		expiresAt                                time.Time
	)
	err := h.pool.QueryRow(r.Context(), `
SELECT tenant_id::text, COALESCE(nonce,''), COALESCE(verifier,''),
       COALESCE(redirect_after,''), expires_at
FROM sso_state WHERE state = $1 AND provider = 'oidc'`, state).
		Scan(&tenantID, &nonce, &verifier, &redirectAfter, &expiresAt)
	if err != nil {
		http.Error(w, "unknown state", http.StatusBadRequest)
		return
	}
	defer func() {
		_, _ = h.pool.Exec(r.Context(), `DELETE FROM sso_state WHERE state = $1`, state)
	}()
	if time.Now().After(expiresAt) {
		http.Error(w, "state expired", http.StatusBadRequest)
		return
	}
	prov, err := h.oidcProvider(r.Context(), tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	claims, err := prov.HandleCallback(r.Context(), code, nonce, verifier)
	if err != nil {
		auditlog.Denied(r, audit.ActionLoginFailure, audit.TargetEntityUser, "", "oidc callback: "+err.Error())
		http.Error(w, "oidc verification failed", http.StatusUnauthorized)
		return
	}
	u, err := h.upsertFederatedUser(r.Context(), tenantID, "oidc", claims.Subject, claims.Email, claims.Name)
	if err != nil {
		http.Error(w, "user reconcile: "+err.Error(), http.StatusInternalServerError)
		return
	}
	signed, err := h.issueSessionJWT(u, tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionLoginSuccess,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     u.ID,
		Next:         map[string]interface{}{"method": "oidc"},
	})
	h.finishSSO(w, r, signed, redirectAfter)
}

// ---------- SAML ----------

func (h *SSOHandler) SAMLInit(w http.ResponseWriter, r *http.Request) {
	tenantID := r.URL.Query().Get("tenant")
	if tenantID == "" {
		tenantID = h.defaultTenant
	}
	prov, err := h.samlProvider(r.Context(), tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	// AuthnRequest in real SAML is a signed XML doc; for the initial cut
	// we redirect to the IdP's SSOURL with a relay state, and let the IdP
	// figure out where to come back to. This is the IdP-initiated +
	// RelayState pattern that all major IdPs support.
	relay := uuid.NewString()
	redirectAfter := r.URL.Query().Get("redirect")
	if !isSafeRedirect(redirectAfter) {
		redirectAfter = "/app/"
	}
	if _, err := h.pool.Exec(r.Context(), `
INSERT INTO sso_state (state, tenant_id, provider, request_id, redirect_after)
VALUES ($1, $2::uuid, 'saml', $3, $4)`,
		relay, tenantID, relay, redirectAfter); err != nil {
		http.Error(w, "state persist: "+err.Error(), http.StatusInternalServerError)
		return
	}
	target := prov.SSOURL() + "?RelayState=" + relay
	http.Redirect(w, r, target, http.StatusFound)
}

func (h *SSOHandler) SAMLACS(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", http.StatusBadRequest)
		return
	}
	relay := r.FormValue("RelayState")
	samlResp := r.FormValue("SAMLResponse")
	if samlResp == "" {
		http.Error(w, "missing SAMLResponse", http.StatusBadRequest)
		return
	}
	var (
		tenantID, redirectAfter string
		expiresAt               time.Time
	)
	// RelayState is optional on IdP-initiated flows; if absent, default to
	// the default tenant and root redirect.
	tenantID = h.defaultTenant
	redirectAfter = "/app/"
	if relay != "" {
		err := h.pool.QueryRow(r.Context(), `
SELECT tenant_id::text, COALESCE(redirect_after,''), expires_at
FROM sso_state WHERE state = $1 AND provider = 'saml'`, relay).
			Scan(&tenantID, &redirectAfter, &expiresAt)
		if err == nil {
			defer func() {
				_, _ = h.pool.Exec(r.Context(), `DELETE FROM sso_state WHERE state = $1`, relay)
			}()
			if time.Now().After(expiresAt) {
				http.Error(w, "state expired", http.StatusBadRequest)
				return
			}
		}
	}
	prov, err := h.samlProvider(r.Context(), tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	attrs, err := prov.HandleResponse(r.Context(), samlResp, prov.EntityID())
	if err != nil {
		auditlog.Denied(r, audit.ActionLoginFailure, audit.TargetEntityUser, "", "saml: "+err.Error())
		http.Error(w, "saml verification failed", http.StatusUnauthorized)
		return
	}
	displayName := strings.TrimSpace(attrs.GivenName + " " + attrs.FamilyName)
	u, err := h.upsertFederatedUser(r.Context(), tenantID, "saml", attrs.NameID, attrs.Email, displayName)
	if err != nil {
		http.Error(w, "user reconcile: "+err.Error(), http.StatusInternalServerError)
		return
	}
	signed, err := h.issueSessionJWT(u, tenantID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	auditlog.Record(r, auditlog.Event{
		Action:       audit.ActionLoginSuccess,
		TargetEntity: audit.TargetEntityUser,
		TargetID:     u.ID,
		Next:         map[string]interface{}{"method": "saml"},
	})
	h.finishSSO(w, r, signed, redirectAfter)
}

// ---------- helpers ----------

func (h *SSOHandler) oidcProvider(ctx context.Context, tenantID string) (*infauth.OAuth2Provider, error) {
	cfg, err := h.identityConfig(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("tenant %s: %w", tenantID, err)
	}
	if cfg == nil {
		return nil, fmt.Errorf("tenant %s has no identity provider configured", tenantID)
	}
	prov, err := h.factory.GetProvider(tenantID, cfg)
	if err != nil {
		return nil, err
	}
	op, ok := prov.(*infauth.OAuth2Provider)
	if !ok {
		return nil, fmt.Errorf("tenant %s is not configured for OIDC", tenantID)
	}
	return op, nil
}

func (h *SSOHandler) samlProvider(ctx context.Context, tenantID string) (*infauth.SAMLProvider, error) {
	cfg, err := h.identityConfig(ctx, tenantID)
	if err != nil {
		return nil, fmt.Errorf("tenant %s: %w", tenantID, err)
	}
	prov, err := h.factory.GetProvider(tenantID, cfg)
	if err != nil {
		return nil, err
	}
	sp, ok := prov.(*infauth.SAMLProvider)
	if !ok {
		return nil, fmt.Errorf("tenant %s is not configured for SAML", tenantID)
	}
	return sp, nil
}

// upsertFederatedUser ensures a local user row exists for the federated
// principal. The local id is a deterministic UUIDv5 over (tenant, subject)
// so future logins resolve to the same row. Roles default to General User
// — operators promote in the admin portal.
func (h *SSOHandler) upsertFederatedUser(ctx context.Context, tenantID, _, subject, email, displayName string) (*user.User, error) {
	stable := uuid.NewSHA1(uuid.NameSpaceDNS, []byte("fsd-mrbs/"+tenantID+"/"+subject)).String()
	username := email
	if username == "" {
		username = subject
	}
	u := &user.User{
		ID:       stable,
		TenantID: tenantID,
		Username: username,
		DN:       displayName,
		Role:     user.RoleGeneralUser,
		IsActive: true,
	}
	if existing, err := h.userRepo.GetByUsername(ctx, tenantID, username); err == nil && existing != nil {
		u.ID = existing.ID
		// Preserve admin-assigned role/regions on subsequent logins.
		if existing.Role != "" {
			u.Role = existing.Role
		}
		u.RegionAccess = existing.RegionAccess
		u.Grade = existing.Grade
	}
	if err := h.userRepo.Save(ctx, *u); err != nil {
		return nil, err
	}
	return u, nil
}

func (h *SSOHandler) issueSessionJWT(u *user.User, tenantID string) (string, error) {
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub":       u.ID,
		"tenant_id": tenantID,
		"role":      u.Role,
		"grade":     u.Grade,
		"regions":   u.RegionAccess,
		"dn":        u.DN,
		"exp":       time.Now().Add(h.sessionTTL).Unix(),
		"iat":       time.Now().Unix(),
	})
	return tok.SignedString(h.jwtSecret)
}

// finishSSO redirects the browser back into the SPA with the session JWT
// included as a fragment (#token=...) so it stays out of server logs. The
// SPA's bootstrap reads window.location.hash and persists the token.
func (h *SSOHandler) finishSSO(w http.ResponseWriter, r *http.Request, token, redirectAfter string) {
	if !isSafeRedirect(redirectAfter) {
		redirectAfter = "/app/"
	}
	url := redirectAfter
	if strings.Contains(url, "#") {
		url += "&token=" + token
	} else {
		url += "#token=" + token
	}
	// If the caller wants the token as JSON (XHR-driven SPA flows), honor
	// the Accept header — useful for headless tests and the e2e suite.
	if strings.Contains(r.Header.Get("Accept"), "application/json") {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": token, "redirect": redirectAfter})
		return
	}
	http.Redirect(w, r, url, http.StatusSeeOther)
}

// isSafeRedirect prevents open redirects: only same-origin paths beginning
// with "/" (and not "//") are accepted.
func isSafeRedirect(s string) bool {
	return s != "" && strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//")
}
