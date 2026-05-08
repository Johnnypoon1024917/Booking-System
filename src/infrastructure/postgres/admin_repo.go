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

func (r *AdminRepo) AddHoliday(ctx context.Context, h admin.Holiday) error {
	query := `INSERT INTO holidays (id, holiday_date, description, is_blocker) VALUES ($1, $2, $3, $4)`
	_, err := r.db.Exec(ctx, query, uuid.New().String(), h.Date.Format("2006-01-02"), h.Description, h.IsBlocker)
	return err
}

func (r *AdminRepo) IsDateHoliday(ctx context.Context, date time.Time) (bool, error) {
	var exists bool
	// Check if the exact date is flagged as a blocker in the database
	query := `SELECT EXISTS(SELECT 1 FROM holidays WHERE holiday_date = $1 AND is_blocker = TRUE)`
	err := r.db.QueryRow(ctx, query, date.Format("2006-01-02")).Scan(&exists)
	return exists, err
}

func (r *AdminRepo) CreateResource(config admin.ResourceConfig) error {
	// Implementation for adding new rooms/vehicles (stubbed for Holiday focus)
	return nil
}
