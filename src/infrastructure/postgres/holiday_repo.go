package postgres

import (
	"context"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/holiday"

	"github.com/jackc/pgx/v5/pgxpool"
)

// holidayRepo implements holiday.Repository using PostgreSQL
type holidayRepo struct {
	db *pgxpool.Pool
}

// NewHolidayRepository creates a new holiday repository instance
func NewHolidayRepository(db *pgxpool.Pool) holiday.Repository {
	return &holidayRepo{db: db}
}

// FindByTenantAndDate retrieves a holiday for a specific tenant on a given date
func (r *holidayRepo) FindByTenantAndDate(ctx context.Context, tenantID string, date time.Time) (*holiday.Holiday, error) {
	query := `
		SELECT id, tenant_id, holiday_date, description, is_blocker, COALESCE(created_by::text,''), created_at
		FROM holidays
		WHERE tenant_id = $1 AND holiday_date = $2
	`

	var h holiday.Holiday
	err := r.db.QueryRow(ctx, query, tenantID, date).Scan(
		&h.ID,
		&h.TenantID,
		&h.HolidayDate,
		&h.Description,
		&h.IsBlocker,
		&h.CreatedBy,
		&h.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to find holiday by tenant and date: %w", err)
	}

	return &h, nil
}

// FindByTenantAndDateRange retrieves all holidays for a tenant within a date range
func (r *holidayRepo) FindByTenantAndDateRange(ctx context.Context, tenantID string, start, end time.Time) ([]holiday.Holiday, error) {
	query := `
		SELECT id, tenant_id, holiday_date, description, is_blocker, COALESCE(created_by::text,''), created_at
		FROM holidays
		WHERE tenant_id = $1 AND holiday_date >= $2 AND holiday_date <= $3
		ORDER BY holiday_date
	`

	rows, err := r.db.Query(ctx, query, tenantID, start, end)
	if err != nil {
		return nil, fmt.Errorf("failed to find holidays by date range: %w", err)
	}
	defer rows.Close()

	var holidays []holiday.Holiday
	for rows.Next() {
		var h holiday.Holiday
		err := rows.Scan(
			&h.ID,
			&h.TenantID,
			&h.HolidayDate,
			&h.Description,
			&h.IsBlocker,
			&h.CreatedBy,
			&h.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan holiday: %w", err)
		}
		holidays = append(holidays, h)
	}

	return holidays, nil
}

// FindAllByTenant retrieves all holidays for a tenant
func (r *holidayRepo) FindAllByTenant(ctx context.Context, tenantID string) ([]holiday.Holiday, error) {
	query := `
		SELECT id, tenant_id, holiday_date, description, is_blocker, COALESCE(created_by::text,''), created_at
		FROM holidays
		WHERE tenant_id = $1
		ORDER BY holiday_date
	`

	rows, err := r.db.Query(ctx, query, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to find all holidays: %w", err)
	}
	defer rows.Close()

	var holidays []holiday.Holiday
	for rows.Next() {
		var h holiday.Holiday
		err := rows.Scan(
			&h.ID,
			&h.TenantID,
			&h.HolidayDate,
			&h.Description,
			&h.IsBlocker,
			&h.CreatedBy,
			&h.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan holiday: %w", err)
		}
		holidays = append(holidays, h)
	}

	return holidays, nil
}

// Save creates or updates a holiday
func (r *holidayRepo) Save(ctx context.Context, h holiday.Holiday) error {
	query := `
		INSERT INTO holidays (id, tenant_id, holiday_date, description, is_blocker, created_by, created_at)
		VALUES ($1, $2, $3, $4, $5, NULLIF($6,'')::uuid, $7)
		ON CONFLICT (id) DO UPDATE
		SET holiday_date = EXCLUDED.holiday_date,
			description = EXCLUDED.description,
			is_blocker = EXCLUDED.is_blocker
	`

	_, err := r.db.Exec(ctx, query,
		h.ID,
		h.TenantID,
		h.HolidayDate,
		h.Description,
		h.IsBlocker,
		h.CreatedBy,
		h.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save holiday: %w", err)
	}
	return nil
}

// Delete removes a holiday by ID
func (r *holidayRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM holidays WHERE id = $1`
	_, err := r.db.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete holiday: %w", err)
	}
	return nil
}
