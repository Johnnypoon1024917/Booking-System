package postgres

import (
	"context"
	"errors"
	"time"

	"fsd-mrbs/src/domain/graphsub"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type GraphSubscriptionRepo struct{ db *pgxpool.Pool }

func NewGraphSubscriptionRepo(db *pgxpool.Pool) *GraphSubscriptionRepo {
	return &GraphSubscriptionRepo{db: db}
}

const gsCols = `id, tenant_id, mailbox_upn, graph_subscription_id, client_state, expires_at, last_renewed_at, created_at`

func (r *GraphSubscriptionRepo) List(ctx context.Context, tenantID string) ([]graphsub.Subscription, error) {
	rows, err := r.db.Query(ctx, `SELECT `+gsCols+` FROM graph_subscriptions WHERE tenant_id = $1 ORDER BY mailbox_upn`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubs(rows)
}

func (r *GraphSubscriptionRepo) GetByMailbox(ctx context.Context, tenantID, mailboxUPN string) (*graphsub.Subscription, error) {
	row := r.db.QueryRow(ctx, `SELECT `+gsCols+` FROM graph_subscriptions WHERE tenant_id = $1 AND mailbox_upn = $2`, tenantID, mailboxUPN)
	s, err := scanSub(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *GraphSubscriptionRepo) GetByGraphID(ctx context.Context, graphID string) (*graphsub.Subscription, error) {
	row := r.db.QueryRow(ctx, `SELECT `+gsCols+` FROM graph_subscriptions WHERE graph_subscription_id = $1`, graphID)
	s, err := scanSub(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (r *GraphSubscriptionRepo) Save(ctx context.Context, s graphsub.Subscription) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO graph_subscriptions (id, tenant_id, mailbox_upn, graph_subscription_id, client_state, expires_at, last_renewed_at)
VALUES (COALESCE(NULLIF($1,'')::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, mailbox_upn) DO UPDATE
SET graph_subscription_id = EXCLUDED.graph_subscription_id,
    client_state          = EXCLUDED.client_state,
    expires_at            = EXCLUDED.expires_at,
    last_renewed_at       = EXCLUDED.last_renewed_at`,
		s.ID, s.TenantID, s.MailboxUPN, s.GraphSubscriptionID, s.ClientState, s.ExpiresAt, s.LastRenewedAt)
	return err
}

func (r *GraphSubscriptionRepo) UpdateExpiry(ctx context.Context, id string, expiry time.Time) error {
	_, err := r.db.Exec(ctx,
		`UPDATE graph_subscriptions SET expires_at = $2, last_renewed_at = NOW() WHERE id = $1`, id, expiry)
	return err
}

func (r *GraphSubscriptionRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM graph_subscriptions WHERE id = $1`, id)
	return err
}

func (r *GraphSubscriptionRepo) ListExpiringBefore(ctx context.Context, t time.Time) ([]graphsub.Subscription, error) {
	rows, err := r.db.Query(ctx, `SELECT `+gsCols+` FROM graph_subscriptions WHERE expires_at <= $1 ORDER BY expires_at`, t)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSubs(rows)
}

func scanSub(row interface{ Scan(...interface{}) error }) (graphsub.Subscription, error) {
	var s graphsub.Subscription
	var lastRenewed *time.Time
	err := row.Scan(&s.ID, &s.TenantID, &s.MailboxUPN, &s.GraphSubscriptionID, &s.ClientState,
		&s.ExpiresAt, &lastRenewed, &s.CreatedAt)
	s.LastRenewedAt = lastRenewed
	return s, err
}

func scanSubs(rows pgxRows) ([]graphsub.Subscription, error) {
	var out []graphsub.Subscription
	for rows.Next() {
		s, err := scanSub(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}
