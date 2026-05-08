package middleware

import (
	"context"
	"net/http"
	"strings"

	"fsd-mrbs/src/domain/user"

	"github.com/golang-jwt/jwt/v5"
)

var JwtSecretKey = []byte("FSD_ENTERPRISE_SECURE_KEY_2026")

// RequireRole enforces Role-Based Access Control
func RequireRole(allowedRoles []string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "Missing or Invalid SSO Token", http.StatusUnauthorized)
			return
		}

		tokenStr := strings.TrimPrefix(authHeader, "Bearer ")
		token, err := jwt.Parse(tokenStr, func(token *jwt.Token) (interface{}, error) {
			return JwtSecretKey, nil
		})

		if err != nil || !token.Valid {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, "Invalid Token Claims", http.StatusUnauthorized)
			return
		}

		userRole := claims["role"].(string)
		hasAccess := false

		// System Admins bypass role restrictions [cite: 331]
		if userRole == user.RoleSystemAdmin {
			hasAccess = true
		} else {
			for _, role := range allowedRoles {
				if role == userRole {
					hasAccess = true
					break
				}
			}
		}

		if !hasAccess {
			http.Error(w, "Forbidden: Insufficient RBAC Privileges", http.StatusForbidden)
			return
		}

		// Inject user info into request context for downstream handlers
		ctx := context.WithValue(r.Context(), "userID", claims["sub"])
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}
