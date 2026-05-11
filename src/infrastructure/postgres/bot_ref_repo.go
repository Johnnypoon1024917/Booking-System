package postgres

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// BotConversationRef captures everything we need to push a proactive
// message back to a Teams user without them initiating contact first.
//
// Bot Framework's REST API requires the original serviceUrl + bot id +
// conversation id; we capture all three on the user's first inbound
// activity and replay them when we want to send a reply.
type BotConversationRef struct {
	ID             string
	TenantID       string
	UserAADID      string
	ConversationID string
	ServiceURL     string
	BotID          string
	ChannelID      string
	RecipientID    string
	UserID         string
}

type BotConversationRefRepo struct{ db *pgxpool.Pool }

func NewBotConversationRefRepo(db *pgxpool.Pool) *BotConversationRefRepo {
	return &BotConversationRefRepo{db: db}
}

// Save upserts by (tenant, user). Each user has one canonical
// conversation reference even if they message us from multiple chats.
func (r *BotConversationRefRepo) Save(ctx context.Context, ref BotConversationRef) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO bot_conversation_refs (tenant_id, user_aad_id, conversation_id, service_url, bot_id, channel_id, recipient_id, user_id)
VALUES ($1, $2, $3, $4, $5, $6, NULLIF($7,''), NULLIF($8,'')::uuid)
ON CONFLICT (tenant_id, user_aad_id) DO UPDATE
SET conversation_id = EXCLUDED.conversation_id,
    service_url     = EXCLUDED.service_url,
    bot_id          = EXCLUDED.bot_id,
    channel_id      = EXCLUDED.channel_id,
    recipient_id    = COALESCE(EXCLUDED.recipient_id, bot_conversation_refs.recipient_id),
    user_id         = COALESCE(EXCLUDED.user_id, bot_conversation_refs.user_id),
    updated_at      = NOW()`,
		ref.TenantID, ref.UserAADID, ref.ConversationID, ref.ServiceURL,
		ref.BotID, ref.ChannelID, ref.RecipientID, ref.UserID)
	return err
}

// GetByUserAADID looks up a reference by the Azure AD object id.
func (r *BotConversationRefRepo) GetByUserAADID(ctx context.Context, tenantID, aadID string) (*BotConversationRef, error) {
	var ref BotConversationRef
	err := r.db.QueryRow(ctx, `
SELECT id, tenant_id::text, user_aad_id, conversation_id, service_url, bot_id, channel_id,
       COALESCE(recipient_id,''), COALESCE(user_id::text,'')
FROM bot_conversation_refs WHERE tenant_id = $1 AND user_aad_id = $2`,
		tenantID, aadID,
	).Scan(&ref.ID, &ref.TenantID, &ref.UserAADID, &ref.ConversationID, &ref.ServiceURL,
		&ref.BotID, &ref.ChannelID, &ref.RecipientID, &ref.UserID)
	if err != nil {
		return nil, err
	}
	return &ref, nil
}

// GetByUserID is the path booking-event consumers use — they have our
// internal user UUID, not the AAD oid.
func (r *BotConversationRefRepo) GetByUserID(ctx context.Context, userID string) (*BotConversationRef, error) {
	var ref BotConversationRef
	err := r.db.QueryRow(ctx, `
SELECT id, tenant_id::text, user_aad_id, conversation_id, service_url, bot_id, channel_id,
       COALESCE(recipient_id,''), COALESCE(user_id::text,'')
FROM bot_conversation_refs WHERE user_id = $1`,
		userID,
	).Scan(&ref.ID, &ref.TenantID, &ref.UserAADID, &ref.ConversationID, &ref.ServiceURL,
		&ref.BotID, &ref.ChannelID, &ref.RecipientID, &ref.UserID)
	if err != nil {
		return nil, err
	}
	return &ref, nil
}
