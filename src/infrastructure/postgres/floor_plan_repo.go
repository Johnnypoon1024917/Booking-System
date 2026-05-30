package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"fsd-mrbs/src/domain/floorplan"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type FloorPlanRepo struct {
	db *pgxpool.Pool
}

func NewFloorPlanRepo(db *pgxpool.Pool) *FloorPlanRepo {
	return &FloorPlanRepo{db: db}
}

const floorPlanColumns = `id, tenant_id, name, shapes, pins, is_default, created_at, updated_at`

func scanFloorPlan(row interface{ Scan(dest ...any) error }) (floorplan.FloorPlan, error) {
	var fp floorplan.FloorPlan
	var shapes, pins []byte
	if err := row.Scan(&fp.ID, &fp.TenantID, &fp.Name, &shapes, &pins, &fp.IsDefault, &fp.CreatedAt, &fp.UpdatedAt); err != nil {
		return fp, err
	}
	fp.Shapes = jsonArrayOrEmpty(shapes)
	fp.Pins = jsonArrayOrEmpty(pins)
	return fp, nil
}

func jsonArrayOrEmpty(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("[]")
	}
	return json.RawMessage(b)
}

func (r *FloorPlanRepo) List(ctx context.Context, tenantID string) ([]floorplan.FloorPlan, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+floorPlanColumns+` FROM floor_plans WHERE tenant_id = $1
		 ORDER BY is_default DESC, name`, tenantID)
	if err != nil {
		return nil, fmt.Errorf("list floor plans: %w", err)
	}
	defer rows.Close()
	out := []floorplan.FloorPlan{}
	for rows.Next() {
		fp, err := scanFloorPlan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, fp)
	}
	return out, nil
}

func (r *FloorPlanRepo) GetByID(ctx context.Context, tenantID, id string) (*floorplan.FloorPlan, error) {
	row := r.db.QueryRow(ctx,
		`SELECT `+floorPlanColumns+` FROM floor_plans WHERE id = $1 AND tenant_id = $2`,
		id, tenantID)
	fp, err := scanFloorPlan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("floor plan not found")
		}
		return nil, err
	}
	return &fp, nil
}

func (r *FloorPlanRepo) Create(ctx context.Context, p floorplan.FloorPlan) (floorplan.FloorPlan, error) {
	if p.ID == "" {
		p.ID = uuid.NewString()
	}
	shapes := normaliseJSONArray(p.Shapes)
	pins := normaliseJSONArray(p.Pins)
	row := r.db.QueryRow(ctx, `
		INSERT INTO floor_plans (id, tenant_id, name, shapes, pins, is_default)
		VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
		RETURNING `+floorPlanColumns,
		p.ID, p.TenantID, p.Name, string(shapes), string(pins), p.IsDefault)
	return scanFloorPlan(row)
}

func (r *FloorPlanRepo) Update(ctx context.Context, p floorplan.FloorPlan) (floorplan.FloorPlan, error) {
	shapes := normaliseJSONArray(p.Shapes)
	pins := normaliseJSONArray(p.Pins)
	row := r.db.QueryRow(ctx, `
		UPDATE floor_plans
		   SET name = $1, shapes = $2::jsonb, pins = $3::jsonb, is_default = $4, updated_at = NOW()
		 WHERE id = $5 AND tenant_id = $6
		 RETURNING `+floorPlanColumns,
		p.Name, string(shapes), string(pins), p.IsDefault, p.ID, p.TenantID)
	fp, err := scanFloorPlan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fp, fmt.Errorf("floor plan not found")
		}
		return fp, err
	}
	return fp, nil
}

func (r *FloorPlanRepo) Delete(ctx context.Context, tenantID, id string) error {
	cmd, err := r.db.Exec(ctx,
		`DELETE FROM floor_plans WHERE id = $1 AND tenant_id = $2`, id, tenantID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("floor plan not found")
	}
	return nil
}

// Duplicate copies an existing plan's shapes into a new row. Doing this in
// SQL with INSERT … SELECT keeps the shapes byte-identical (no
// serialise/deserialise round-trip) and avoids race conditions where the
// source mutates between read and write.
func (r *FloorPlanRepo) Duplicate(ctx context.Context, tenantID, sourceID, newName string) (floorplan.FloorPlan, error) {
	newID := uuid.NewString()
	row := r.db.QueryRow(ctx, `
		INSERT INTO floor_plans (id, tenant_id, name, shapes, is_default)
		SELECT $1, tenant_id, $2, shapes, FALSE
		  FROM floor_plans
		 WHERE id = $3 AND tenant_id = $4
		RETURNING `+floorPlanColumns,
		newID, newName, sourceID, tenantID)
	fp, err := scanFloorPlan(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fp, fmt.Errorf("source floor plan not found")
		}
		return fp, fmt.Errorf("duplicate floor plan: %w", err)
	}
	return fp, nil
}

// SetDefault wraps the flip in a transaction so the partial unique index
// (one default per tenant) never sees two TRUE rows mid-update.
func (r *FloorPlanRepo) SetDefault(ctx context.Context, tenantID, id string) error {
	tx, err := r.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`UPDATE floor_plans SET is_default = FALSE WHERE tenant_id = $1 AND is_default = TRUE`,
		tenantID); err != nil {
		return err
	}
	cmd, err := tx.Exec(ctx,
		`UPDATE floor_plans SET is_default = TRUE WHERE id = $1 AND tenant_id = $2`,
		id, tenantID)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return fmt.Errorf("floor plan not found")
	}
	return tx.Commit(ctx)
}

func normaliseJSONArray(in json.RawMessage) json.RawMessage {
	if len(in) == 0 {
		return json.RawMessage("[]")
	}
	return in
}
