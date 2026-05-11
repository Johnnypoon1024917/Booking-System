package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CheckinTokenRepo persists single-use QR tokens issued at booking time.
type CheckinTokenRepo struct {
	pool *pgxpool.Pool
}

func NewCheckinTokenRepo(pool *pgxpool.Pool) *CheckinTokenRepo {
	return &CheckinTokenRepo{pool: pool}
}

func (r *CheckinTokenRepo) Issue(ctx context.Context, tenantID, bookingID string, expiresAt time.Time, token string) error {
	_, err := r.pool.Exec(ctx,
		`INSERT INTO checkin_tokens (token, tenant_id, booking_id, expires_at) VALUES ($1, $2, $3, $4)`,
		token, tenantID, bookingID, expiresAt,
	)
	return err
}

func (r *CheckinTokenRepo) Resolve(ctx context.Context, token string) (string, string, time.Time, bool, error) {
	var tenantID, bookingID string
	var expiresAt time.Time
	var consumedAt *time.Time
	err := r.pool.QueryRow(ctx,
		`SELECT tenant_id::text, booking_id::text, expires_at, consumed_at FROM checkin_tokens WHERE token = $1`,
		token,
	).Scan(&tenantID, &bookingID, &expiresAt, &consumedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", time.Time{}, false, errors.New("token not found")
	}
	if err != nil {
		return "", "", time.Time{}, false, err
	}
	return tenantID, bookingID, expiresAt, consumedAt != nil, nil
}

func (r *CheckinTokenRepo) Consume(ctx context.Context, token string) error {
	_, err := r.pool.Exec(ctx,
		`UPDATE checkin_tokens SET consumed_at = NOW() WHERE token = $1 AND consumed_at IS NULL`,
		token,
	)
	return err
}
