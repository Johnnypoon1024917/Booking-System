package handlers

import (
	"encoding/json"
	"net/http"
	"os"

	"fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/postgres"
)

// TeamsNotifyHandler proactively sends a Teams message to a user using
// their stored ConversationReference. Used by booking lifecycle events
// (approval, rejection, reminder) that should reach the user wherever
// they are — including outside their session in the SPA.
//
//   POST /api/v1/teams/notify       { user_id: "...", text: "...", card?: {...} }
//
// In-app admin only. Bot credentials come from BOT_APP_ID + BOT_APP_PASSWORD.
type TeamsNotifyHandler struct {
	refs   *postgres.BotConversationRefRepo
	client *integration.ProactiveBotClient
}

func NewTeamsNotifyHandler(refs *postgres.BotConversationRefRepo, client *integration.ProactiveBotClient) *TeamsNotifyHandler {
	return &TeamsNotifyHandler{refs: refs, client: client}
}

func (h *TeamsNotifyHandler) Notify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		UserID string         `json:"user_id"`
		Text   string         `json:"text"`
		Card   map[string]any `json:"card"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.UserID == "" {
		http.Error(w, "user_id required", http.StatusBadRequest)
		return
	}
	ref, err := h.refs.GetByUserID(r.Context(), body.UserID)
	if err != nil || ref == nil {
		http.Error(w, "no conversation reference for that user — they need to greet the bot at least once", http.StatusNotFound)
		return
	}
	appID := os.Getenv("BOT_APP_ID")
	appPwd := os.Getenv("BOT_APP_PASSWORD")
	if appID == "" || appPwd == "" {
		http.Error(w, "BOT_APP_ID / BOT_APP_PASSWORD not configured", http.StatusServiceUnavailable)
		return
	}
	if err := h.client.Send(r.Context(), appID, appPwd, ref.ServiceURL, ref.ConversationID, body.Text, body.Card); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}
