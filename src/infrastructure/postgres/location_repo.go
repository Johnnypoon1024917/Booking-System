package postgres

import (
	"context"
	"errors"
	"fmt"

	"fsd-mrbs/src/domain/location"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LocationRepo struct {
	db *pgxpool.Pool
}

func NewLocationRepo(db *pgxpool.Pool) *LocationRepo {
	return &LocationRepo{db: db}
}

const locColumns = `id, tenant_id, name, region, created_at, updated_at`

func scanLocation(row interface{ Scan(dest ...any) error }) (location.Location, error) {
	var l location.Location
	if err := row.Scan(&l.ID, &l.TenantID, &l.Name, &l.Region, &l.CreatedAt, &l.UpdatedAt); err != nil {
		return l, err
	}
	return l, nil
}

func (r *LocationRepo) List(ctx context.Context, tenantID string) ([]location.Location, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+locColumns+` FROM locations WHERE tenant_id = $1 ORDER BY name`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list locations: %w", err)
	}
	defer rows.Close()
	out := []location.Location{}
	for rows.Next() {
		l, err := scanLocation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, nil
}

func (r *LocationRepo) Create(ctx context.Context, l location.Location) (location.Location, error) {
	if l.ID == "" {
		l.ID = uuid.NewString()
	}
	row := r.db.QueryRow(ctx, `
		INSERT INTO locations (id, tenant_id, name, region)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (tenant_id, name) DO UPDATE SET region = EXCLUDED.region, updated_at = NOW()
		RETURNING `+locColumns,
		l.ID, l.TenantID, l.Name, l.Region)
	return scanLocation(row)
}

func (r *LocationRepo) Update(ctx context.Context, l location.Location) (location.Location, error) {
	row := r.db.QueryRow(ctx, `
		UPDATE locations SET name = $1, region = $2, updated_at = NOW()
		 WHERE id = $3 AND tenant_id = $4
		 RETURNING `+locColumns,
		l.Name, l.Region, l.ID, l.TenantID)
	ll, err := scanLocation(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ll, fmt.Errorf("location not found")
		}
		return ll, err
	}
	return ll, nil
}

func (r *LocationRepo) Delete(ctx context.Context, tenantID, id string) error {
	cmd, err := r.db.Exec(ctx,
		`DELETE FROM locations WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("location not found")
	}
	return nil
}
