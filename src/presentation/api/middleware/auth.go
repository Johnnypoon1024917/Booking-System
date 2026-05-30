package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"fsd-mrbs/src/domain/user"

	"github.com/golang-jwt/jwt/v5"
)

// JwtSecretKey is loaded once at process start from the JWT_SECRET env var.
//
// Production deployments MUST set JWT_SECRET to a value of at least 32
// bytes; the process fails closed if it is missing, too short, or
// recognisably weak. Setting ALLOW_DEV_JWT_EPHEMERAL_KEY=true permits a
// random per-process key to be used for local development only — any user
// must re-login if the API restarts, which is acceptable in development
// and intolerable in production.
var JwtSecretKey = loadJwtSecret()

func loadJwtSecret() []byte {
	if v := os.Getenv("JWT_SECRET"); v != "" {
		if len(v) < 32 {
			log.Fatalf("JWT_SECRET must be at least 32 bytes (got %d). Refusing to start.", len(v))
		}
		if isWeakSecret(v) {
			log.Fatalf("JWT_SECRET appears to be a placeholder or example value. Refusing to start.")
		}
		return []byte(v)
	}
	if strings.EqualFold(os.Getenv("ALLOW_DEV_JWT_EPHEMERAL_KEY"), "true") {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			log.Fatalf("could not generate JWT secret: %v", err)
		}
		log.Printf("WARNING: ALLOW_DEV_JWT_EPHEMERAL_KEY=true — using ephemeral JWT key (hex prefix=%s…). NEVER USE IN PRODUCTION.", hex.EncodeToString(buf[:4]))
		return buf
	}
	log.Fatalf("JWT_SECRET is not set. Set JWT_SECRET (>=32 bytes) or, for local dev only, ALLOW_DEV_JWT_EPHEMERAL_KEY=true.")
	return nil
}

// isWeakSecret rejects a small set of obviously bad placeholder values that
// developers sometimes paste into config. Not a substitute for proper entropy.
func isWeakSecret(s string) bool {
	lower := strings.ToLower(s)
	for _, bad := range []string{"changeme", "secret", "password", "example", "placeholder", "todo", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"} {
		if strings.Contains(lower, bad) {
			return true
		}
	}
	return false
}

// RequireRole enforces Role-Based Access Control (wraps http.HandlerFunc).
// Kept for backwards compatibility; new routes should use RequireRoleHandler.
func RequireRole(allowedRoles []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := authenticate(w, r)
		if !ok {
			return
		}
		if !roleAllowed(claims, allowedRoles) {
			http.Error(w, "Forbidden: Insufficient RBAC Privileges", http.StatusForbidden)
			return
		}
		ctx := context.WithValue(r.Context(), "userID", claims["sub"])
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

// RequireRoleHandler enforces RBAC and is intended to be wrapped by other
// middlewares (e.g. tenant) using the http.Handler interface.
func RequireRoleHandler(allowedRoles []string, next http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims, ok := authenticate(w, r)
		if !ok {
			return
		}
		if !roleAllowed(claims, allowedRoles) {
			http.Error(w, "Forbidden: Insufficient RBAC Privileges", http.StatusForbidden)
			return
		}
		ctx := r.Context()
		ctx = context.WithValue(ctx, "userID", claims["sub"])
		if role, ok := claims["role"].(string); ok {
			ctx = context.WithValue(ctx, "userRole", role)
		}
		if regions, ok := claims["regions"].([]interface{}); ok {
			list := make([]string, 0, len(regions))
			for _, r := range regions {
				if s, ok := r.(string); ok {
					list = append(list, s)
				}
			}
			ctx = context.WithValue(ctx, "userRegions", list)
		}
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func authenticate(w http.ResponseWriter, r *http.Request) (jwt.MapClaims, bool) {
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		http.Error(w, "Missing or Invalid SSO Token", http.StatusUnauthorized)
		return nil, false
	}
	tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
	token, err := jwt.Parse(
		tokenStr,
		func(t *jwt.Token) (interface{}, error) {
			// Pin the signing algorithm exactly — accepting any HMAC variant
			// (HS256/HS384/HS512) widens the attack surface unnecessarily.
			if t.Method.Alg() != jwt.SigningMethodHS256.Alg() {
				return nil, jwt.ErrSignatureInvalid
			}
			return JwtSecretKey, nil
		},
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second),
	)
	if err != nil || !token.Valid {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return nil, false
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		http.Error(w, "Invalid Token Claims", http.StatusUnauthorized)
		return nil, false
	}
	return claims, true
}

// roleAllowed returns true if the caller's role is explicitly listed in the
// allowed set. System Admin used to be auto-granted; that implicit bypass
// has been removed. Every route must enumerate every role it permits — this
// makes audit and least-privilege review tractable and forces a deliberate
// decision for SystemAdmin reach on each endpoint.
func roleAllowed(claims jwt.MapClaims, allowed []string) bool {
	role, _ := claims["role"].(string)
	for _, r := range allowed {
		if r == role {
			return true
		}
	}
	return false
}

// keep the user import used for the role constants referenced by callers.
var _ = user.RoleSystemAdmin
