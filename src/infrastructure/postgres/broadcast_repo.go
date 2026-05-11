package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/broadcast"

	"github.com/jackc/pgx/v5/pgxpool"
)

// broadcastRepo implements broadcast.Repository using PostgreSQL
type broadcastRepo struct {
	db *pgxpool.Pool
}

// NewBroadcastRepository creates a new broadcast repository instance
func NewBroadcastRepository(db *pgxpool.Pool) broadcast.Repository {
	return &broadcastRepo{db: db}
}

// FindByID retrieves a broadcast by its ID
func (r *broadcastRepo) FindByID(ctx context.Context, id string) (*broadcast.Broadcast, error) {
	query := `
		SELECT id, tenant_id, title, content, image_url, start_date, end_date, filters, COALESCE(created_by::text,''), created_at
		FROM broadcasts
		WHERE id = $1
	`

	var b broadcast.Broadcast
	var filtersJSON []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&b.ID,
		&b.TenantID,
		&b.Title,
		&b.Content,
		&b.ImageURL,
		&b.StartDate,
		&b.EndDate,
		&filtersJSON,
		&b.CreatedBy,
		&b.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to find broadcast by id: %w", err)
	}

	// Unmarshal filters JSONB
	if len(filtersJSON) > 0 && string(filtersJSON) != "null" {
		json.Unmarshal(filtersJSON, &b.Filters)
	}

	return &b, nil
}

// FindByTenant retrieves all broadcasts for a tenant
func (r *broadcastRepo) FindByTenant(ctx context.Context, tenantID string) ([]broadcast.Broadcast, error) {
	query := `
		SELECT id, tenant_id, title, content, image_url, start_date, end_date, filters, COALESCE(created_by::text,''), created_at
		FROM broadcasts
		WHERE tenant_id = $1
		ORDER BY start_date DESC
	`

	rows, err := r.db.Query(ctx, query, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to find broadcasts by tenant: %w", err)
	}
	defer rows.Close()

	var broadcasts []broadcast.Broadcast
	for rows.Next() {
		var b broadcast.Broadcast
		var filtersJSON []byte

		err := rows.Scan(
			&b.ID,
			&b.TenantID,
			&b.Title,
			&b.Content,
			&b.ImageURL,
			&b.StartDate,
			&b.EndDate,
			&filtersJSON,
			&b.CreatedBy,
			&b.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan broadcast: %w", err)
		}

		// Unmarshal filters JSONB
		if len(filtersJSON) > 0 && string(filtersJSON) != "null" {
			json.Unmarshal(filtersJSON, &b.Filters)
		}

		broadcasts = append(broadcasts, b)
	}

	return broadcasts, nil
}

// FindActive retrieves all active broadcasts for a tenant within the current time
func (r *broadcastRepo) FindActive(ctx context.Context, tenantID string, now time.Time) ([]broadcast.Broadcast, error) {
	query := `
		SELECT id, tenant_id, title, content, image_url, start_date, end_date, filters, COALESCE(created_by::text,''), created_at
		FROM broadcasts
		WHERE tenant_id = $1 AND start_date <= $2 AND end_date >= $2
		ORDER BY start_date DESC
	`

	rows, err := r.db.Query(ctx, query, tenantID, now)
	if err != nil {
		return nil, fmt.Errorf("failed to find active broadcasts: %w", err)
	}
	defer rows.Close()

	var broadcasts []broadcast.Broadcast
	for rows.Next() {
		var b broadcast.Broadcast
		var filtersJSON []byte

		err := rows.Scan(
			&b.ID,
			&b.TenantID,
			&b.Title,
			&b.Content,
			&b.ImageURL,
			&b.StartDate,
			&b.EndDate,
			&filtersJSON,
			&b.CreatedBy,
			&b.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan broadcast: %w", err)
		}

		// Unmarshal filters JSONB
		if len(filtersJSON) > 0 && string(filtersJSON) != "null" {
			json.Unmarshal(filtersJSON, &b.Filters)
		}

		broadcasts = append(broadcasts, b)
	}

	return broadcasts, nil
}

// FindByDateRange retrieves broadcasts that overlap with a given date range
func (r *broadcastRepo) FindByDateRange(ctx context.Context, tenantID string, start, end time.Time) ([]broadcast.Broadcast, error) {
	query := `
		SELECT id, tenant_id, title, content, image_url, start_date, end_date, filters, COALESCE(created_by::text,''), created_at
		FROM broadcasts
		WHERE tenant_id = $1 AND (start_date <= $3 AND end_date >= $2)
		ORDER BY start_date DESC
	`

	rows, err := r.db.Query(ctx, query, tenantID, start, end)
	if err != nil {
		return nil, fmt.Errorf("failed to find broadcasts by date range: %w", err)
	}
	defer rows.Close()

	var broadcasts []broadcast.Broadcast
	for rows.Next() {
		var b broadcast.Broadcast
		var filtersJSON []byte

		err := rows.Scan(
			&b.ID,
			&b.TenantID,
			&b.Title,
			&b.Content,
			&b.ImageURL,
			&b.StartDate,
			&b.EndDate,
			&filtersJSON,
			&b.CreatedBy,
			&b.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan broadcast: %w", err)
		}

		// Unmarshal filters JSONB
		if len(filtersJSON) > 0 && string(filtersJSON) != "null" {
			json.Unmarshal(filtersJSON, &b.Filters)
		}

		broadcasts = append(broadcasts, b)
	}

	return broadcasts, nil
}

// Save creates or updates a broadcast
func (r *broadcastRepo) Save(ctx context.Context, b broadcast.Broadcast) error {
	filtersJSON, _ := json.Marshal(b.Filters)

	query := `
		INSERT INTO broadcasts (id, tenant_id, title, content, image_url, start_date, end_date, filters, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9,'')::uuid, $10)
		ON CONFLICT (id) DO UPDATE
		SET title = EXCLUDED.title,
			content = EXCLUDED.content,
			image_url = EXCLUDED.image_url,
			start_date = EXCLUDED.start_date,
			end_date = EXCLUDED.end_date,
			filters = EXCLUDED.filters
	`

	_, err := r.db.Exec(ctx, query,
		b.ID,
		b.TenantID,
		b.Title,
		b.Content,
		b.ImageURL,
		b.StartDate,
		b.EndDate,
		filtersJSON,
		b.CreatedBy,
		b.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save broadcast: %w", err)
	}
	return nil
}

// Delete removes a broadcast by ID
func (r *broadcastRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM broadcasts WHERE id = $1`
	_, err := r.db.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete broadcast: %w", err)
	}
	return nil
}
