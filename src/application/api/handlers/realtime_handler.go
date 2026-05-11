package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	"fsd-mrbs/src/infrastructure/realtime"
	"fsd-mrbs/src/presentation/api/middleware"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
)

// RealtimeHandler upgrades an HTTP request to a tenant-scoped WebSocket
// connection that streams availability/broadcast events.
//
// JWT lives in the `?token=` query param because browsers can't set
// Authorization headers on WebSocket handshakes. The token is verified
// here in-line using the same secret as the standard middleware.
type RealtimeHandler struct {
	Hub *realtime.Hub
}

func NewRealtimeHandler(hub *realtime.Hub) *RealtimeHandler {
	return &RealtimeHandler{Hub: hub}
}

func (h *RealtimeHandler) ServeWS(w http.ResponseWriter, r *http.Request) {
	raw := r.URL.Query().Get("token")
	if raw == "" {
		// Fallback: some clients can still send bearer through the protocol header.
		ah := r.Header.Get("Sec-WebSocket-Protocol")
		raw = strings.TrimSpace(ah)
	}
	if raw == "" {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	token, err := jwt.Parse(raw, func(t *jwt.Token) (interface{}, error) {
		// Enforce HMAC; otherwise an attacker could submit an "alg=none"
		// token and it would still parse against our HMAC secret.
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, jwt.ErrSignatureInvalid
		}
		return middleware.JwtSecretKey, nil
	})
	if err != nil {
		slog.Warn("realtime: token parse failed", "err", err.Error())
		http.Error(w, "invalid token: "+err.Error(), http.StatusUnauthorized)
		return
	}
	if !token.Valid {
		slog.Warn("realtime: token invalid")
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		http.Error(w, "invalid claims", http.StatusUnauthorized)
		return
	}
	tenantStr, _ := claims["tenant_id"].(string)
	tenantID, err := uuid.Parse(tenantStr)
	if err != nil {
		slog.Warn("realtime: bad tenant claim", "tenant", tenantStr, "err", err.Error())
		http.Error(w, "invalid tenant", http.StatusUnauthorized)
		return
	}
	h.Hub.ServeWS(tenantID, w, r)
}
