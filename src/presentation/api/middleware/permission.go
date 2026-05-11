package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"fsd-mrbs/src/domain/permission"
)

// PermissionMiddleware enforces the granular permission catalog. It wraps
// any HTTP handler and rejects with 403 when the caller's role doesn't
// hold the required permission key.
//
// We keep a small in-memory cache (per tenant, 5 min TTL) so each request
// doesn't hit the database. When a tenant admin updates the matrix the
// new values become effective within the TTL — for instant rollout, call
// Invalidate() from the admin handler after Set.
type PermissionMiddleware struct {
	repo permission.Repository

	mu    sync.RWMutex
	cache map[string]cachedMatrix // keyed by tenantID
	ttl   time.Duration
}

type cachedMatrix struct {
	matrix *permission.RoleMatrix
	at     time.Time
}

func NewPermissionMiddleware(repo permission.Repository) *PermissionMiddleware {
	return &PermissionMiddleware{
		repo:  repo,
		cache: make(map[string]cachedMatrix),
		ttl:   5 * time.Minute,
	}
}

// Require returns an http.Handler wrapper that allows the request only if
// the caller's role holds `key`. If the matrix can't be loaded we fail
// closed (403).
func (p *PermissionMiddleware) Require(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		role, _ := r.Context().Value("userRole").(string)
		if role == "" {
			http.Error(w, "no role on request", http.StatusUnauthorized)
			return
		}
		// System Admin always wins (escape hatch when matrices get tangled).
		if role == "System Admin" {
			next.ServeHTTP(w, r)
			return
		}
		tenantID, ok := tenantIDFromCtxStr(r)
		if !ok {
			http.Error(w, "no tenant on request", http.StatusUnauthorized)
			return
		}
		matrix, err := p.matrixFor(r.Context(), tenantID)
		if err != nil {
			slog.Warn("permission check: load matrix", "err", err, "key", key, "tenant", tenantID)
			http.Error(w, "permission load failed", http.StatusForbidden)
			return
		}
		if !matrix.Has(role, key) {
			slog.Info("permission denied", "key", key, "role", role, "tenant", tenantID)
			http.Error(w, "forbidden: missing permission "+key, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// RequireFunc is the http.HandlerFunc convenience wrapper.
func (p *PermissionMiddleware) RequireFunc(key string, next http.HandlerFunc) http.Handler {
	return p.Require(key, http.HandlerFunc(next))
}

// Invalidate purges the cache for one tenant. Call this from the
// permission admin handler after Set.
func (p *PermissionMiddleware) Invalidate(tenantID string) {
	p.mu.Lock()
	delete(p.cache, tenantID)
	p.mu.Unlock()
}

func (p *PermissionMiddleware) matrixFor(ctx context.Context, tenantID string) (*permission.RoleMatrix, error) {
	p.mu.RLock()
	if v, ok := p.cache[tenantID]; ok && time.Since(v.at) < p.ttl {
		p.mu.RUnlock()
		return v.matrix, nil
	}
	p.mu.RUnlock()
	m, err := p.repo.Get(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.cache[tenantID] = cachedMatrix{matrix: m, at: time.Now()}
	p.mu.Unlock()
	return m, nil
}

// tenantIDFromCtxStr is the middleware-local accessor — returns string form
// without dragging the handler-internal helper here.
func tenantIDFromCtxStr(r *http.Request) (string, bool) {
	v := r.Context().Value(TenantIDKey)
	if v == nil {
		v = r.Context().Value("tenant_id")
	}
	if v == nil {
		v = r.Context().Value("tenantID")
	}
	switch t := v.(type) {
	case string:
		return t, t != ""
	}
	// uuid.UUID, etc. — best-effort stringify
	if t, ok := v.(interface{ String() string }); ok {
		s := t.String()
		return s, s != "" && s != "00000000-0000-0000-0000-000000000000"
	}
	return "", false
}
