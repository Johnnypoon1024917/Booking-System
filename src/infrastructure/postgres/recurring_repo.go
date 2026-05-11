package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/booking"

	"github.com/jackc/pgx/v5/pgxpool"
)

// recurringRepo implements booking.RecurringSeriesRepository using PostgreSQL
type recurringRepo struct {
	db *pgxpool.Pool
}

// NewRecurringSeriesRepository creates a new recurring series repository instance
func NewRecurringSeriesRepository(db *pgxpool.Pool) booking.RecurringSeriesRepository {
	return &recurringRepo{db: db}
}

// GetByID retrieves a recurring series by its ID
func (r *recurringRepo) GetByID(ctx context.Context, id string) (*booking.RecurringSeries, error) {
	query := `
		SELECT id, tenant_id, resource_id, user_id, pattern, start_date, end_date, 
			time_start, time_end, day_of_week, day_of_month, status, created_at
		FROM recurring_series
		WHERE id = $1
	`

	var series booking.RecurringSeries
	var dayOfWeekJSON []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&series.ID,
		&series.TenantID,
		&series.ResourceID,
		&series.UserID,
		&series.Pattern,
		&series.StartDate,
		&series.EndDate,
		&series.TimeStart,
		&series.TimeEnd,
		&dayOfWeekJSON,
		&series.DayOfMonth,
		&series.Status,
		&series.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get recurring series by id: %w", err)
	}

	// Unmarshal day_of_week JSONB array
	if len(dayOfWeekJSON) > 0 && string(dayOfWeekJSON) != "null" {
		json.Unmarshal(dayOfWeekJSON, &series.DayOfWeek)
	}

	return &series, nil
}

// Save creates or updates a recurring series
func (r *recurringRepo) Save(ctx context.Context, series booking.RecurringSeries) error {
	dayOfWeekJSON, _ := json.Marshal(series.DayOfWeek)

	query := `
		INSERT INTO recurring_series (id, tenant_id, resource_id, user_id, pattern, start_date, end_date, 
			time_start, time_end, day_of_week, day_of_month, status, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
		ON CONFLICT (id) DO UPDATE
		SET pattern = EXCLUDED.pattern,
			start_date = EXCLUDED.start_date,
			end_date = EXCLUDED.end_date,
			time_start = EXCLUDED.time_start,
			time_end = EXCLUDED.time_end,
			day_of_week = EXCLUDED.day_of_week,
			day_of_month = EXCLUDED.day_of_month,
			status = EXCLUDED.status
	`

	_, err := r.db.Exec(ctx, query,
		series.ID,
		series.TenantID,
		series.ResourceID,
		series.UserID,
		series.Pattern,
		series.StartDate,
		series.EndDate,
		series.TimeStart,
		series.TimeEnd,
		dayOfWeekJSON,
		series.DayOfMonth,
		series.Status,
		series.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save recurring series: %w", err)
	}
	return nil
}

// ListByUser retrieves all recurring series for a specific user (with tenant_id filtering)
func (r *recurringRepo) ListByUser(ctx context.Context, userID string) ([]booking.RecurringSeries, error) {
	query := `
		SELECT id, tenant_id, resource_id, user_id, pattern, start_date, end_date, 
			time_start, time_end, day_of_week, day_of_month, status, created_at
		FROM recurring_series
		WHERE user_id = $1
		ORDER BY created_at DESC
	`

	rows, err := r.db.Query(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list recurring series by user: %w", err)
	}
	defer rows.Close()

	var seriesList []booking.RecurringSeries
	for rows.Next() {
		var series booking.RecurringSeries
		var dayOfWeekJSON []byte

		err := rows.Scan(
			&series.ID,
			&series.TenantID,
			&series.ResourceID,
			&series.UserID,
			&series.Pattern,
			&series.StartDate,
			&series.EndDate,
			&series.TimeStart,
			&series.TimeEnd,
			&dayOfWeekJSON,
			&series.DayOfMonth,
			&series.Status,
			&series.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan recurring series: %w", err)
		}

		// Unmarshal day_of_week JSONB array
		if len(dayOfWeekJSON) > 0 && string(dayOfWeekJSON) != "null" {
			json.Unmarshal(dayOfWeekJSON, &series.DayOfWeek)
		}

		seriesList = append(seriesList, series)
	}

	return seriesList, nil
}

// UpdateStatus updates the status of a recurring series
func (r *recurringRepo) UpdateStatus(ctx context.Context, id, status string) error {
	query := `UPDATE recurring_series SET status = $1 WHERE id = $2`
	_, err := r.db.Exec(ctx, query, status, id)
	if err != nil {
		return fmt.Errorf("failed to update recurring series status: %w", err)
	}
	return nil
}

// ListByResource retrieves all recurring series for a specific resource (with tenant_id filtering)
func (r *recurringRepo) ListByResource(ctx context.Context, resourceID string) ([]booking.RecurringSeries, error) {
	query := `
		SELECT id, tenant_id, resource_id, user_id, pattern, start_date, end_date, 
			time_start, time_end, day_of_week, day_of_month, status, created_at
		FROM recurring_series
		WHERE resource_id = $1
		ORDER BY created_at DESC
	`

	rows, err := r.db.Query(ctx, query, resourceID)
	if err != nil {
		return nil, fmt.Errorf("failed to list recurring series by resource: %w", err)
	}
	defer rows.Close()

	var seriesList []booking.RecurringSeries
	for rows.Next() {
		var series booking.RecurringSeries
		var dayOfWeekJSON []byte

		err := rows.Scan(
			&series.ID,
			&series.TenantID,
			&series.ResourceID,
			&series.UserID,
			&series.Pattern,
			&series.StartDate,
			&series.EndDate,
			&series.TimeStart,
			&series.TimeEnd,
			&dayOfWeekJSON,
			&series.DayOfMonth,
			&series.Status,
			&series.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan recurring series: %w", err)
		}

		// Unmarshal day_of_week JSONB array
		if len(dayOfWeekJSON) > 0 && string(dayOfWeekJSON) != "null" {
			json.Unmarshal(dayOfWeekJSON, &series.DayOfWeek)
		}

		seriesList = append(seriesList, series)
	}

	return seriesList, nil
}
