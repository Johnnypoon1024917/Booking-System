package postgres

import (
	"context"
	"errors"
	"fmt"

	"fsd-mrbs/src/domain/locationgroup"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type LocationGroupRepo struct {
	db *pgxpool.Pool
}

func NewLocationGroupRepo(db *pgxpool.Pool) *LocationGroupRepo {
	return &LocationGroupRepo{db: db}
}

const lugColumns = `id, tenant_id, name, filter_by, approvers, locations, status, created_at, updated_at`

func scanLocationGroup(row interface{ Scan(dest ...any) error }) (locationgroup.LocationGroup, error) {
	var g locationgroup.LocationGroup
	var approvers, locations []byte
	if err := row.Scan(&g.ID, &g.TenantID, &g.Name, &g.FilterBy, &approvers, &locations, &g.Status, &g.CreatedAt, &g.UpdatedAt); err != nil {
		return g, err
	}
	g.Approvers = jsonArrayOrEmpty(approvers)
	g.Locations = jsonArrayOrEmpty(locations)
	return g, nil
}

func (r *LocationGroupRepo) List(ctx context.Context, tenantID string) ([]locationgroup.LocationGroup, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+lugColumns+` FROM location_user_groups WHERE tenant_id = $1 ORDER BY name`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list location groups: %w", err)
	}
	defer rows.Close()
	out := []locationgroup.LocationGroup{}
	for rows.Next() {
		g, err := scanLocationGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

func (r *LocationGroupRepo) Create(ctx context.Context, g locationgroup.LocationGroup) (locationgroup.LocationGroup, error) {
	if g.ID == "" {
		g.ID = uuid.NewString()
	}
	row := r.db.QueryRow(ctx, `
		INSERT INTO location_user_groups (id, tenant_id, name, filter_by, approvers, locations, status)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
		RETURNING `+lugColumns,
		g.ID, g.TenantID, g.Name, g.FilterBy,
		string(normaliseJSONArray(g.Approvers)), string(normaliseJSONArray(g.Locations)), g.Status)
	return scanLocationGroup(row)
}

func (r *LocationGroupRepo) Update(ctx context.Context, g locationgroup.LocationGroup) (locationgroup.LocationGroup, error) {
	row := r.db.QueryRow(ctx, `
		UPDATE location_user_groups
		   SET name = $1, filter_by = $2, approvers = $3::jsonb, locations = $4::jsonb,
		       status = $5, updated_at = NOW()
		 WHERE id = $6 AND tenant_id = $7
		 RETURNING `+lugColumns,
		g.Name, g.FilterBy, string(normaliseJSONArray(g.Approvers)),
		string(normaliseJSONArray(g.Locations)), g.Status, g.ID, g.TenantID)
	gg, err := scanLocationGroup(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return gg, fmt.Errorf("location group not found")
		}
		return gg, err
	}
	return gg, nil
}

func (r *LocationGroupRepo) Delete(ctx context.Context, tenantID, id string) error {
	cmd, err := r.db.Exec(ctx,
		`DELETE FROM location_user_groups WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("location group not found")
	}
	return nil
}
