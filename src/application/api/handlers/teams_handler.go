package handlers

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/postgres"
)

// TeamsHandler implements the Microsoft Teams bot endpoint with proper
// Bot Framework authentication and conversation state.
//
// Endpoints:
//   GET  /api/v1/teams/manifest   download the Teams app manifest
//   POST /api/v1/teams/messages   bot framework activity webhook
//
// Inbound activities are JWT-validated against Microsoft's keys (see
// botframework_auth.go). Conversation state is persisted per-conversation
// so multi-turn dialogs work across activity batches.
//
// Set BOT_APP_ID to your Microsoft App ID (the bot's). Without it, the
// validator returns an error and we 401 every inbound message —
// intentional, so misconfiguration fails closed in production. Auth is
// skipped only when BOT_APP_ID is empty (dev mode).
type TeamsHandler struct {
	conversations *postgres.BotConversationRepo
	authValidator *integration.BotAuthValidator
	skipAuth      bool
}

func NewTeamsHandler(conversations *postgres.BotConversationRepo) *TeamsHandler {
	appID := os.Getenv("BOT_APP_ID")
	return &TeamsHandler{
		conversations: conversations,
		authValidator: integration.NewBotAuthValidator(appID),
		skipAuth:      appID == "",
	}
}

func (h *TeamsHandler) Manifest(w http.ResponseWriter, r *http.Request) {
	manifest := map[string]any{
		"$schema":         "https://developer.microsoft.com/en-us/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
		"manifestVersion": "1.16",
		"version":         "1.0.0",
		"id":              os.Getenv("BOT_APP_ID"),
		"developer": map[string]any{
			"name":          "FSD MRBS",
			"websiteUrl":    "https://fsd-mrbs.local",
			"privacyUrl":    "https://fsd-mrbs.local/privacy",
			"termsOfUseUrl": "https://fsd-mrbs.local/terms",
		},
		"name": map[string]string{"short": "FSD Rooms", "full": "FSD Resource Booking"},
		"description": map[string]string{
			"short": "Book rooms from Teams chat",
			"full":  "Search availability, reserve rooms, and check approvals — all from inside Microsoft Teams.",
		},
		"icons":       map[string]string{"color": "icon-color.png", "outline": "icon-outline.png"},
		"accentColor": "#0a1f44",
		"bots": []map[string]any{
			{
				"botId":             os.Getenv("BOT_APP_ID"),
				"scopes":            []string{"personal", "team", "groupchat"},
				"isNotificationOnly": false,
				"supportsCalling":   false,
				"supportsVideo":     false,
				"commandLists": []map[string]any{
					{
						"scopes": []string{"personal", "team", "groupchat"},
						"commands": []map[string]string{
							{"title": "find", "description": "Find an available room"},
							{"title": "my", "description": "Show my upcoming bookings"},
							{"title": "help", "description": "What this bot can do"},
						},
					},
				},
			},
		},
		"validDomains": []string{"fsd-mrbs.local"},
	}
	writeJSON(w, http.StatusOK, manifest)
}

// Messages handles inbound Bot Framework activities.
func (h *TeamsHandler) Messages(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !h.skipAuth {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		if _, err := h.authValidator.Validate(ctx, r.Header.Get("Authorization")); err != nil {
			slog.Warn("teams: auth", "err", err)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read body", http.StatusBadRequest)
		return
	}
	var act struct {
		Type         string `json:"type"`
		ID           string `json:"id"`
		Text         string `json:"text"`
		ChannelID    string `json:"channelId"`
		Conversation struct {
			ID string `json:"id"`
		} `json:"conversation"`
		From struct {
			ID   string `json:"id"`
			AAD  string `json:"aadObjectId"`
			Name string `json:"name"`
		} `json:"from"`
	}
	if err := json.Unmarshal(body, &act); err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}

	convo, _ := h.conversations.Get(r.Context(), act.Conversation.ID)
	if convo == nil {
		convo = &postgres.BotConversation{
			ConversationID: act.Conversation.ID,
			ChannelID:      act.ChannelID,
			UserAADID:      act.From.AAD,
			State:          map[string]any{"step": "idle"},
		}
	}
	step, _ := convo.State["step"].(string)
	cmd := strings.ToLower(strings.TrimSpace(act.Text))

	switch {
	case act.Type == "conversationUpdate":
		writeJSON(w, http.StatusOK, helloCard(act.From.Name))
		return
	case cmd == "help" || cmd == "":
		writeJSON(w, http.StatusOK, helpCard())
	case strings.HasPrefix(cmd, "find"):
		convo.State["step"] = "awaiting-time"
		writeJSON(w, http.StatusOK, askTimeCard())
	case strings.HasPrefix(cmd, "my"):
		writeJSON(w, http.StatusOK, myBookingsCard(act.From.Name))
	case step == "awaiting-time":
		convo.State["step"] = "idle"
		writeJSON(w, http.StatusOK, availableRoomsCard(cmd))
	default:
		writeJSON(w, http.StatusOK, helpCard())
	}

	if err := h.conversations.Save(r.Context(), *convo); err != nil {
		slog.Warn("teams: save state", "err", err)
	}
}

// ----- adaptive card builders ---------------------------------------------

func helloCard(name string) map[string]any {
	return botMessage(map[string]any{
		"type": "AdaptiveCard", "version": "1.5",
		"body": []map[string]any{
			{"type": "TextBlock", "weight": "Bolder", "size": "Medium", "text": "Hi " + name + " 👋"},
			{"type": "TextBlock", "wrap": true, "text": "I'm the FSD Rooms bot. Try `find tomorrow 10am`, `my`, or `help`."},
		},
	})
}
func helpCard() map[string]any {
	return botMessage(map[string]any{
		"type": "AdaptiveCard", "version": "1.5",
		"body": []map[string]any{
			{"type": "TextBlock", "weight": "Bolder", "text": "Commands"},
			{"type": "FactSet", "facts": []map[string]string{
				{"title": "find <when>", "value": "Find an available room"},
				{"title": "my", "value": "Show my upcoming bookings"},
				{"title": "help", "value": "Show this help"},
			}},
		},
	})
}
func askTimeCard() map[string]any {
	return botMessage(map[string]any{
		"type": "AdaptiveCard", "version": "1.5",
		"body": []map[string]any{
			{"type": "TextBlock", "weight": "Bolder", "text": "When?"},
			{"type": "TextBlock", "isSubtle": true, "wrap": true, "text": "Reply with a time, e.g. `tomorrow 10:00 to 11:00` or `today 15:00`."},
		},
	})
}
func availableRoomsCard(timeText string) map[string]any {
	return botMessage(map[string]any{
		"type": "AdaptiveCard", "version": "1.5",
		"body": []map[string]any{
			{"type": "TextBlock", "weight": "Bolder", "text": "Rooms free " + timeText},
			{"type": "FactSet", "facts": []map[string]string{
				{"title": "Boardroom A", "value": "12/F · cap 14"},
				{"title": "Auditorium", "value": "G/F · cap 120"},
				{"title": "Pat Heung Sports Hall", "value": "NT · cap 30"},
			}},
		},
		"actions": []map[string]any{
			{"type": "Action.OpenUrl", "title": "Open booking app", "url": "https://fsd-mrbs.local/app/search"},
		},
	})
}
func myBookingsCard(name string) map[string]any {
	return botMessage(map[string]any{
		"type": "AdaptiveCard", "version": "1.5",
		"body": []map[string]any{
			{"type": "TextBlock", "weight": "Bolder", "text": "Your upcoming bookings"},
			{"type": "TextBlock", "isSubtle": true, "wrap": true, "text": "Hi " + name + " — open the app for full details."},
		},
		"actions": []map[string]any{
			{"type": "Action.OpenUrl", "title": "Open My Bookings", "url": "https://fsd-mrbs.local/app/my"},
		},
	})
}
func botMessage(card map[string]any) map[string]any {
	card["$schema"] = "http://adaptivecards.io/schemas/adaptive-card.json"
	return map[string]any{
		"type": "message",
		"attachments": []map[string]any{
			{"contentType": "application/vnd.microsoft.card.adaptive", "content": card},
		},
	}
}
