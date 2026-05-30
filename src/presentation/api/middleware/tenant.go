package middleware

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/tenant"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ContextKey type for context keys to avoid collisions
type ContextKey string

const (
	// TenantIDKey is the context key for tenant ID
	TenantIDKey ContextKey = "tenantID"
	// TenantKey is the context key for the full tenant object
	TenantKey ContextKey = "tenant"
	// UserIDKey is the context key for user ID
	UserIDKey ContextKey = "userID"
	// UserRoleKey is the context key for user role
	UserRoleKey ContextKey = "userRole"
	// UserGradeKey is the context key for user grade
	UserGradeKey ContextKey = "userGrade"
	// UserRegionsKey is the context key for user region access
	UserRegionsKey ContextKey = "userRegions"
)

// TenantMiddleware extracts tenant information from JWT claims and sets up
// the database session for row-level security.
//
// The middleware:
// 1. Extracts tenant_id from JWT claims
// 2. Validates tenant status (rejects if suspended/deleted)
// 3. Sets the database session variable: SET app.current_tenant_id = '<tenant-uuid>'
// 4. Injects tenant context into request for downstream handlers
type TenantMiddleware struct {
	tenantRepo postgres.TenantRepository
	dbPool     *pgxpool.Pool
}

// NewTenantMiddleware creates a new TenantMiddleware instance
func NewTenantMiddleware(dbPool *pgxpool.Pool) *TenantMiddleware {
	return &TenantMiddleware{
		tenantRepo: postgres.NewTenantRepository(dbPool),
		dbPool:     dbPool,
	}
}

// Middleware returns the tenant middleware handler
// This should be used AFTER the authentication middleware
func (tm *TenantMiddleware) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Extract JWT claims from request context (set by auth middleware)
		// If not present, extract from token directly
		claims := extractClaimsFromRequest(r)
		if claims == nil {
			http.Error(w, "Missing or invalid authentication token", http.StatusUnauthorized)
			return
		}

		// Extract tenant_id from claims. Every authenticated principal —
		// including System Admin — MUST present a tenant scope; cross-tenant
		// operations must be performed by re-issuing a token bound to the
		// target tenant, never by waving through a tenant-less request.
		tenantIDStr, ok := claims["tenant_id"].(string)
		if !ok || tenantIDStr == "" {
			http.Error(w, "Tenant ID not found in token claims", http.StatusUnauthorized)
			return
		}

		// Parse tenant ID
		tenantID, err := uuid.Parse(tenantIDStr)
		if err != nil {
			http.Error(w, "Invalid tenant ID format in token", http.StatusUnauthorized)
			return
		}

		// Fetch tenant and validate status
		t, err := tm.tenantRepo.GetByID(r.Context(), tenantID)
		if err != nil {
			http.Error(w, "Tenant not found", http.StatusUnauthorized)
			return
		}

		// Validate tenant status - R1.4: Reject operations for suspended/deleted tenants
		if !t.CanPerformOperations() {
			var statusMsg string
			switch t.Status {
			case tenant.StatusSuspended:
				statusMsg = "Tenant is suspended. All operations are blocked."
			case tenant.StatusDeleted:
				statusMsg = "Tenant has been deleted."
			default:
				statusMsg = fmt.Sprintf("Tenant status is '%s'. Operations are not allowed.", t.Status)
			}
			http.Error(w, statusMsg, http.StatusForbidden)
			return
		}

		// Set the database session variable for row-level security
		// This enables the RLS policies to filter data by tenant_id
		if err := tm.tenantRepo.SetTenantContext(r.Context(), tenantID); err != nil {
			http.Error(w, "Failed to establish tenant context", http.StatusInternalServerError)
			return
		}

		// Inject tenant context into request for downstream handlers.
		// Both the typed key (canonical) and the bare-string key are set so
		// handlers written against either style work uniformly.
		ctx := r.Context()
		ctx = context.WithValue(ctx, TenantIDKey, tenantID)
		ctx = context.WithValue(ctx, TenantKey, t)
		ctx = context.WithValue(ctx, "tenant_id", tenantID)
		ctx = context.WithValue(ctx, "tenantID", tenantID)
		ctx = context.WithValue(ctx, "tenant", t)

		// Also extract and inject other user claims
		if sub, ok := claims["sub"].(string); ok {
			ctx = context.WithValue(ctx, UserIDKey, sub)
		}
		if role, ok := claims["role"].(string); ok {
			ctx = context.WithValue(ctx, UserRoleKey, role)
		}
		if grade, ok := claims["grade"].(string); ok {
			ctx = context.WithValue(ctx, UserGradeKey, grade)
		}
		if regions, ok := claims["regions"].([]interface{}); ok {
			// Convert []interface{} to []string
			regionStrs := make([]string, 0, len(regions))
			for _, r := range regions {
				if rs, ok := r.(string); ok {
					regionStrs = append(regionStrs, rs)
				}
			}
			ctx = context.WithValue(ctx, UserRegionsKey, regionStrs)
		}

		// Continue with the request
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// extractClaimsFromRequest extracts JWT claims from the request
// It first checks the context (set by RequireRole middleware), then falls back to parsing the token
func extractClaimsFromRequest(r *http.Request) jwt.MapClaims {
	// Try to get claims from Authorization header
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		return nil
	}

	tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
	token, err := jwt.Parse(
		tokenStr,
		func(t *jwt.Token) (interface{}, error) {
			if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, jwt.ErrSignatureInvalid
			}
			return JwtSecretKey, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithExpirationRequired(),
	)
	if err != nil || !token.Valid {
		return nil
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil
	}

	return claims
}

// RequireTenant wraps an HTTP handler and ensures tenant context is set
// This is a convenience function for routes that require tenant isolation
func RequireTenant(dbPool *pgxpool.Pool, next http.Handler) http.Handler {
	tm := NewTenantMiddleware(dbPool)
	return tm.Middleware(next)
}

// GetTenantID extracts the tenant ID from the request context
func GetTenantID(ctx context.Context) (uuid.UUID, bool) {
	tenantID, ok := ctx.Value(TenantIDKey).(uuid.UUID)
	return tenantID, ok
}

// GetTenant extracts the full tenant object from the request context
func GetTenant(ctx context.Context) (*tenant.Tenant, bool) {
	t, ok := ctx.Value(TenantKey).(*tenant.Tenant)
	return t, ok
}

// GetUserID extracts the user ID from the request context
func GetUserID(ctx context.Context) (string, bool) {
	userID, ok := ctx.Value(UserIDKey).(string)
	return userID, ok
}

// GetUserRole extracts the user role from the request context
func GetUserRole(ctx context.Context) (string, bool) {
	role, ok := ctx.Value(UserRoleKey).(string)
	return role, ok
}

// GetUserGrade extracts the user grade from the request context
func GetUserGrade(ctx context.Context) (string, bool) {
	grade, ok := ctx.Value(UserGradeKey).(string)
	return grade, ok
}

// GetUserRegions extracts the user region access from the request context
func GetUserRegions(ctx context.Context) ([]string, bool) {
	regions, ok := ctx.Value(UserRegionsKey).([]string)
	return regions, ok
}
