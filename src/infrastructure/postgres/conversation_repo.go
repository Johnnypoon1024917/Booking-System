package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BotConversation tracks per-conversation dialog state for the Teams bot.
type BotConversation struct {
	ConversationID string
	TenantID       string
	ChannelID      string
	UserAADID      string
	State          map[string]any
}

type BotConversationRepo struct{ db *pgxpool.Pool }

func NewBotConversationRepo(db *pgxpool.Pool) *BotConversationRepo {
	return &BotConversationRepo{db: db}
}

func (r *BotConversationRepo) Get(ctx context.Context, conversationID string) (*BotConversation, error) {
	var c BotConversation
	var stateJSON []byte
	var tenant, channel, user *string
	err := r.db.QueryRow(ctx,
		`SELECT conversation_id, tenant_id::text, channel_id, user_aad_id, state
         FROM bot_conversations WHERE conversation_id = $1`, conversationID,
	).Scan(&c.ConversationID, &tenant, &channel, &user, &stateJSON)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if tenant != nil { c.TenantID = *tenant }
	if channel != nil { c.ChannelID = *channel }
	if user != nil { c.UserAADID = *user }
	if len(stateJSON) > 0 {
		_ = json.Unmarshal(stateJSON, &c.State)
	}
	return &c, nil
}

func (r *BotConversationRepo) Save(ctx context.Context, c BotConversation) error {
	state, _ := json.Marshal(c.State)
	_, err := r.db.Exec(ctx, `
INSERT INTO bot_conversations (conversation_id, tenant_id, channel_id, user_aad_id, state)
VALUES ($1, NULLIF($2,'')::uuid, NULLIF($3,''), NULLIF($4,''), $5::jsonb)
ON CONFLICT (conversation_id) DO UPDATE
SET tenant_id   = COALESCE(EXCLUDED.tenant_id, bot_conversations.tenant_id),
    channel_id  = COALESCE(EXCLUDED.channel_id, bot_conversations.channel_id),
    user_aad_id = COALESCE(EXCLUDED.user_aad_id, bot_conversations.user_aad_id),
    state       = EXCLUDED.state,
    updated_at  = NOW()`,
		c.ConversationID, c.TenantID, c.ChannelID, c.UserAADID, state)
	return err
}
