package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strings"

	"fsd-mrbs/src/domain/user"

	"github.com/golang-jwt/jwt/v5"
)

// JwtSecretKey is loaded once at process start. Set JWT_SECRET in production.
// In development, if it's not set, we generate a random key per process so
// existing tokens become invalid on restart but no one can guess the key
// from source code.
var JwtSecretKey = loadJwtSecret()

func loadJwtSecret() []byte {
	if v := os.Getenv("JWT_SECRET"); v != "" {
		if len(v) < 32 {
			log.Printf("WARNING: JWT_SECRET is shorter than 32 bytes (%d). Use at least 32.", len(v))
		}
		return []byte(v)
	}
	// Dev / first-run: random key per process. Any user must re-login if the
	// API restarts, but we never ship a hardcoded secret in builds.
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		log.Fatalf("could not generate JWT secret: %v", err)
	}
	log.Printf("JWT_SECRET not set; generated ephemeral key (hex prefix=%s…). Set JWT_SECRET for production.", hex.EncodeToString(buf[:4]))
	return buf
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
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return JwtSecretKey, nil
	})
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

func roleAllowed(claims jwt.MapClaims, allowed []string) bool {
	role, _ := claims["role"].(string)
	if role == user.RoleSystemAdmin {
		return true
	}
	for _, r := range allowed {
		if r == role {
			return true
		}
	}
	return false
}
