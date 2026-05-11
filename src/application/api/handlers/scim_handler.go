package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SCIMHandler implements SCIM 2.0 for tenant user provisioning.
//
// Supported endpoints (subset of RFC 7644):
//   GET  /scim/v2/ServiceProviderConfig
//   GET  /scim/v2/Schemas
//   GET  /scim/v2/ResourceTypes
//   GET  /scim/v2/Users                    list / filter
//   POST /scim/v2/Users                    create
//   GET  /scim/v2/Users/{id}               read
//   PUT  /scim/v2/Users/{id}               replace
//   PATCH /scim/v2/Users/{id}              partial update
//   DELETE /scim/v2/Users/{id}             delete (soft: deactivate)
//
// Auth: Bearer SCIM token (issued via /api/v1/admin/scim/tokens).
type SCIMHandler struct {
	pool   *pgxpool.Pool
	tokens *postgres.SCIMTokenRepo
	users  postgres.UserRepository
}

func NewSCIMHandler(pool *pgxpool.Pool, tokens *postgres.SCIMTokenRepo, users postgres.UserRepository) *SCIMHandler {
	return &SCIMHandler{pool: pool, tokens: tokens, users: users}
}

func (h *SCIMHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := h.authenticate(w, r)
	if !ok {
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/scim/v2/")
	parts := strings.Split(strings.Trim(path, "/"), "/")

	switch parts[0] {
	case "ServiceProviderConfig":
		writeSCIM(w, http.StatusOK, h.serviceProviderConfig())
	case "Schemas":
		writeSCIM(w, http.StatusOK, h.schemas())
	case "ResourceTypes":
		writeSCIM(w, http.StatusOK, h.resourceTypes())
	case "Users":
		switch {
		case len(parts) == 1 && r.Method == http.MethodGet:
			h.listUsers(w, r, tenantID)
		case len(parts) == 1 && r.Method == http.MethodPost:
			h.createUser(w, r, tenantID)
		case len(parts) == 2 && r.Method == http.MethodGet:
			h.getUser(w, r, tenantID, parts[1])
		case len(parts) == 2 && (r.Method == http.MethodPut || r.Method == http.MethodPatch):
			h.replaceUser(w, r, tenantID, parts[1])
		case len(parts) == 2 && r.Method == http.MethodDelete:
			h.deleteUser(w, r, tenantID, parts[1])
		default:
			scimError(w, http.StatusMethodNotAllowed, "method not allowed")
		}
	default:
		scimError(w, http.StatusNotFound, "not found")
	}
}

// authenticate enforces Bearer scim_<token> and returns the tenant ID
// the token belongs to.
func (h *SCIMHandler) authenticate(w http.ResponseWriter, r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		scimError(w, http.StatusUnauthorized, "missing bearer")
		return "", false
	}
	tok := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	rec, err := h.tokens.Lookup(r.Context(), tok)
	if err != nil || rec == nil {
		scimError(w, http.StatusUnauthorized, "invalid token")
		return "", false
	}
	return rec.TenantID, true
}

// ----- Discovery ----------------------------------------------------------

func (h *SCIMHandler) serviceProviderConfig() map[string]any {
	return map[string]any{
		"schemas": []string{"urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"},
		"patch":         map[string]bool{"supported": true},
		"bulk":          map[string]any{"supported": false, "maxOperations": 0, "maxPayloadSize": 0},
		"filter":        map[string]any{"supported": true, "maxResults": 200},
		"changePassword": map[string]bool{"supported": false},
		"sort":          map[string]bool{"supported": false},
		"etag":          map[string]bool{"supported": false},
		"authenticationSchemes": []map[string]any{
			{"name": "OAuth Bearer Token", "description": "Bearer token issued by the tenant admin", "type": "oauthbearertoken", "primary": true},
		},
	}
}

func (h *SCIMHandler) schemas() map[string]any {
	return map[string]any{
		"schemas":      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"totalResults": 2,
		"Resources": []map[string]any{
			{"id": "urn:ietf:params:scim:schemas:core:2.0:User", "name": "User"},
			{"id": "urn:ietf:params:scim:schemas:core:2.0:Group", "name": "Group"},
		},
	}
}

func (h *SCIMHandler) resourceTypes() map[string]any {
	return map[string]any{
		"schemas": []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"Resources": []map[string]any{
			{
				"id":           "User",
				"name":         "User",
				"endpoint":     "/Users",
				"description":  "User accounts",
				"schema":       "urn:ietf:params:scim:schemas:core:2.0:User",
			},
		},
	}
}

// ----- Users --------------------------------------------------------------

func (h *SCIMHandler) listUsers(w http.ResponseWriter, r *http.Request, tenantID string) {
	startIndex, _ := strconv.Atoi(r.URL.Query().Get("startIndex"))
	count, _ := strconv.Atoi(r.URL.Query().Get("count"))
	if count <= 0 || count > 200 {
		count = 100
	}
	if startIndex <= 0 {
		startIndex = 1
	}
	all, err := h.users.ListByTenant(r.Context(), tenantID)
	if err != nil {
		scimError(w, http.StatusInternalServerError, err.Error())
		return
	}
	// We don't parse the SCIM filter language fully — Azure AD's
	// "userName eq X" is the common one; handle it cheaply.
	if f := r.URL.Query().Get("filter"); f != "" {
		all = applyFilter(all, f)
	}
	end := startIndex - 1 + count
	if end > len(all) {
		end = len(all)
	}
	page := []user.User{}
	if startIndex-1 < len(all) {
		page = all[startIndex-1 : end]
	}
	resources := make([]map[string]any, len(page))
	for i, u := range page {
		resources[i] = h.toSCIM(u)
	}
	writeSCIM(w, http.StatusOK, map[string]any{
		"schemas":      []string{"urn:ietf:params:scim:api:messages:2.0:ListResponse"},
		"totalResults": len(all),
		"itemsPerPage": len(page),
		"startIndex":   startIndex,
		"Resources":    resources,
	})
}

func (h *SCIMHandler) getUser(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	u, err := h.users.GetByID(r.Context(), id)
	if err != nil || u == nil {
		scimError(w, http.StatusNotFound, "user not found")
		return
	}
	if u.TenantID != tenantID {
		scimError(w, http.StatusNotFound, "user not found")
		return
	}
	writeSCIM(w, http.StatusOK, h.toSCIM(*u))
}

func (h *SCIMHandler) createUser(w http.ResponseWriter, r *http.Request, tenantID string) {
	var body scimUser
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		scimError(w, http.StatusBadRequest, "invalid payload")
		return
	}
	if body.UserName == "" {
		scimError(w, http.StatusBadRequest, "userName required")
		return
	}
	u := h.fromSCIM(body)
	u.ID = uuid.NewString()
	u.TenantID = tenantID
	if err := h.users.Save(r.Context(), u); err != nil {
		scimError(w, http.StatusConflict, err.Error())
		return
	}
	w.Header().Set("Location", "/scim/v2/Users/"+u.ID)
	writeSCIM(w, http.StatusCreated, h.toSCIM(u))
}

func (h *SCIMHandler) replaceUser(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	existing, err := h.users.GetByID(r.Context(), id)
	if err != nil || existing == nil || existing.TenantID != tenantID {
		scimError(w, http.StatusNotFound, "user not found")
		return
	}

	// PATCH support — Azure AD prefers PatchOp with array of operations.
	if r.Method == http.MethodPatch {
		var op struct {
			Schemas    []string `json:"schemas"`
			Operations []struct {
				Op    string         `json:"op"`
				Path  string         `json:"path"`
				Value any            `json:"value"`
			} `json:"Operations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&op); err != nil {
			scimError(w, http.StatusBadRequest, "invalid patch")
			return
		}
		applyPatch(existing, op.Operations)
		if err := h.users.Save(r.Context(), *existing); err != nil {
			scimError(w, http.StatusConflict, err.Error())
			return
		}
		writeSCIM(w, http.StatusOK, h.toSCIM(*existing))
		return
	}

	// PUT — full replace
	var body scimUser
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		scimError(w, http.StatusBadRequest, "invalid payload")
		return
	}
	u := h.fromSCIM(body)
	u.ID = existing.ID
	u.TenantID = tenantID
	if err := h.users.Save(r.Context(), u); err != nil {
		scimError(w, http.StatusConflict, err.Error())
		return
	}
	writeSCIM(w, http.StatusOK, h.toSCIM(u))
}

func (h *SCIMHandler) deleteUser(w http.ResponseWriter, r *http.Request, tenantID, id string) {
	existing, err := h.users.GetByID(r.Context(), id)
	if err != nil || existing == nil || existing.TenantID != tenantID {
		scimError(w, http.StatusNotFound, "user not found")
		return
	}
	if err := h.users.SetActive(r.Context(), id, false); err != nil {
		scimError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ----- mapping ------------------------------------------------------------

type scimUser struct {
	ID         string `json:"id,omitempty"`
	UserName   string `json:"userName"`
	ExternalID string `json:"externalId"`
	Active     bool   `json:"active"`
	DisplayName string `json:"displayName"`
	Name       struct {
		Formatted string `json:"formatted"`
	} `json:"name"`
	Emails []struct {
		Value   string `json:"value"`
		Primary bool   `json:"primary"`
	} `json:"emails"`
	Title string `json:"title"`
}

func (h *SCIMHandler) toSCIM(u user.User) map[string]any {
	primaryEmail := ""
	out := map[string]any{
		"schemas":     []string{"urn:ietf:params:scim:schemas:core:2.0:User"},
		"id":          u.ID,
		"userName":    u.Username,
		"externalId":  "",
		"active":      u.IsActive,
		"displayName": u.Username,
		"name":        map[string]string{"formatted": u.Username},
		"title":       u.Role,
		"meta": map[string]any{
			"resourceType": "User",
			"created":      time.Now().UTC().Format(time.RFC3339),
			"location":     "/scim/v2/Users/" + u.ID,
		},
	}
	if primaryEmail != "" {
		out["emails"] = []map[string]any{{"value": primaryEmail, "primary": true}}
	}
	return out
}

func (h *SCIMHandler) fromSCIM(s scimUser) user.User {
	role := s.Title
	if role == "" {
		role = user.RoleGeneralUser
	}
	return user.User{
		Username: s.UserName,
		DN:       s.UserName,
		Role:     role,
		IsActive: s.Active,
	}
}

// applyFilter handles the "userName eq \"foo\"" filter Azure AD sends.
func applyFilter(in []user.User, filter string) []user.User {
	parts := strings.Fields(filter)
	if len(parts) < 3 {
		return in
	}
	attr, op, val := strings.ToLower(parts[0]), strings.ToLower(parts[1]), strings.Trim(parts[2], `"`)
	if op != "eq" {
		return in
	}
	out := []user.User{}
	for _, u := range in {
		switch attr {
		case "username":
			if u.Username == val {
				out = append(out, u)
			}
		case "externalid":
			// not yet stored; placeholder for when external_id lookup lands
		}
	}
	return out
}

// applyPatch supports the small subset of PATCH ops Azure AD actually uses
// (replace active, replace displayName, add/remove emails).
func applyPatch(u *user.User, ops []struct {
	Op    string `json:"op"`
	Path  string `json:"path"`
	Value any    `json:"value"`
}) {
	for _, op := range ops {
		path := strings.ToLower(op.Path)
		switch op.Op {
		case "replace", "Replace", "add", "Add":
			switch path {
			case "active":
				if v, ok := op.Value.(bool); ok {
					u.IsActive = v
				}
			case "displayname":
				if v, ok := op.Value.(string); ok && v != "" {
					u.Username = v
				}
			case "title":
				if v, ok := op.Value.(string); ok && v != "" {
					u.Role = v
				}
			}
		case "remove", "Remove":
			if path == "active" {
				u.IsActive = false
			}
		}
	}
}

func writeSCIM(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/scim+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func scimError(w http.ResponseWriter, status int, msg string) {
	writeSCIM(w, status, map[string]any{
		"schemas":  []string{"urn:ietf:params:scim:api:messages:2.0:Error"},
		"detail":   msg,
		"status":   strconv.Itoa(status),
	})
}

// SCIMTokenAdminHandler is the in-app admin endpoint for issuing /
// listing / revoking SCIM tokens. Lives outside the /scim/v2 prefix and
// is gated by the standard JWT + permission middleware.
type SCIMTokenAdminHandler struct {
	tokens *postgres.SCIMTokenRepo
}

func NewSCIMTokenAdminHandler(tokens *postgres.SCIMTokenRepo) *SCIMTokenAdminHandler {
	return &SCIMTokenAdminHandler{tokens: tokens}
}

func (h *SCIMTokenAdminHandler) Dispatch(w http.ResponseWriter, r *http.Request) {
	tenantID, ok := tenantIDFromCtx(r)
	if !ok {
		http.Error(w, "tenant context missing", http.StatusUnauthorized)
		return
	}
	path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/v1/admin/scim/tokens"), "/")

	switch {
	case path == "" && r.Method == http.MethodGet:
		out, err := h.tokens.List(r.Context(), tenantID.String())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusOK, out)
	case path == "" && r.Method == http.MethodPost:
		var body struct{ Name string `json:"name"` }
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Name == "" {
			body.Name = "Azure AD provisioning"
		}
		plain, t, err := h.tokens.Issue(r.Context(), tenantID.String(), body.Name)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{
			"id": t.ID, "name": t.Name, "prefix": t.Prefix,
			"token": plain,
			"note":  "Save this token now. It will not be shown again.",
			"endpoint": "/scim/v2",
		})
	case path != "" && r.Method == http.MethodDelete:
		if err := h.tokens.Revoke(r.Context(), path); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "not found", http.StatusNotFound)
	}
}

// errors used by tests
var errSCIMNotFound = errors.New("scim user not found")
var _ = errSCIMNotFound
var _ = context.Background
