package postgres

import (
	"context"
	"fmt"

	"fsd-mrbs/src/domain/meeting"

	"github.com/jackc/pgx/v5/pgxpool"
)

// meetingRedirectRepo implements meeting.Repository using PostgreSQL
type meetingRedirectRepo struct {
	db *pgxpool.Pool
}

// NewMeetingRedirectRepository creates a new meeting redirect repository instance
func NewMeetingRedirectRepository(db *pgxpool.Pool) meeting.Repository {
	return &meetingRedirectRepo{db: db}
}

// GetByStaticURL retrieves a meeting redirect by its static URL
func (r *meetingRedirectRepo) GetByStaticURL(ctx context.Context, staticURL string) (*meeting.MeetingRedirect, error) {
	query := `
		SELECT id, tenant_id, booking_id, static_url, original_url, created_at
		FROM meeting_redirects
		WHERE static_url = $1
	`

	var redirect meeting.MeetingRedirect
	err := r.db.QueryRow(ctx, query, staticURL).Scan(
		&redirect.ID,
		&redirect.TenantID,
		&redirect.BookingID,
		&redirect.StaticURL,
		&redirect.OriginalURL,
		&redirect.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get meeting redirect by static url: %w", err)
	}

	return &redirect, nil
}

// GetByBookingID retrieves a meeting redirect by its booking ID (with tenant_id filtering)
func (r *meetingRedirectRepo) GetByBookingID(ctx context.Context, bookingID string) (*meeting.MeetingRedirect, error) {
	query := `
		SELECT id, tenant_id, booking_id, static_url, original_url, created_at
		FROM meeting_redirects
		WHERE booking_id = $1
	`

	var redirect meeting.MeetingRedirect
	err := r.db.QueryRow(ctx, query, bookingID).Scan(
		&redirect.ID,
		&redirect.TenantID,
		&redirect.BookingID,
		&redirect.StaticURL,
		&redirect.OriginalURL,
		&redirect.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get meeting redirect by booking id: %w", err)
	}

	return &redirect, nil
}

// Save creates or updates a meeting redirect
func (r *meetingRedirectRepo) Save(ctx context.Context, redirect meeting.MeetingRedirect) error {
	query := `
		INSERT INTO meeting_redirects (id, tenant_id, booking_id, static_url, original_url, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE
		SET static_url = EXCLUDED.static_url,
			original_url = EXCLUDED.original_url
	`

	_, err := r.db.Exec(ctx, query,
		redirect.ID,
		redirect.TenantID,
		redirect.BookingID,
		redirect.StaticURL,
		redirect.OriginalURL,
		redirect.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save meeting redirect: %w", err)
	}
	return nil
}

// UpdateOriginalURL updates the original URL of a meeting redirect
func (r *meetingRedirectRepo) UpdateOriginalURL(ctx context.Context, id, originalURL string) error {
	query := `UPDATE meeting_redirects SET original_url = $1 WHERE id = $2`
	_, err := r.db.Exec(ctx, query, originalURL, id)
	if err != nil {
		return fmt.Errorf("failed to update meeting redirect original url: %w", err)
	}
	return nil
}

// Delete removes a meeting redirect by ID (with tenant_id filtering via RLS)
func (r *meetingRedirectRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM meeting_redirects WHERE id = $1`
	_, err := r.db.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete meeting redirect: %w", err)
	}
	return nil
}
