package postgres

import (
	"context"
	"fsd-mrbs/src/domain/admin"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type AdminRepo struct {
	db *pgxpool.Pool
}

func NewAdminRepo(db *pgxpool.Pool) *AdminRepo {
	return &AdminRepo{db: db}
}

// CreateResource now correctly implements the AdminRepository interface
func (r *AdminRepo) CreateResource(ctx context.Context, config admin.ResourceConfig) error {
	query := `
		INSERT INTO resources (id, name, asset_type, region, location, capacity, is_restricted, requires_approval)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`

	_, err := r.db.Exec(ctx, query,
		uuid.New().String(),
		config.Name,
		config.AssetType,
		config.Region,
		config.Location,
		config.Capacity,
		config.IsRestricted,
		config.RequiresApproval,
	)
	return err
}

func (r *AdminRepo) AddHoliday(ctx context.Context, h admin.Holiday) error {
	query := `INSERT INTO holidays (id, holiday_date, description, is_blocker) VALUES ($1, $2, $3, $4)`
	_, err := r.db.Exec(ctx, query, uuid.New().String(), h.Date.Format("2006-01-02"), h.Description, h.IsBlocker)
	return err
}

func (r *AdminRepo) IsDateHoliday(ctx context.Context, date time.Time) (bool, error) {
	var exists bool
	query := `SELECT EXISTS(SELECT 1 FROM holidays WHERE holiday_date = $1 AND is_blocker = TRUE)`
	err := r.db.QueryRow(ctx, query, date.Format("2006-01-02")).Scan(&exists)
	return exists, err
}
