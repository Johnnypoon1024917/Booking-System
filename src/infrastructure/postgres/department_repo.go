package postgres

import (
	"context"
	"errors"
	"fmt"

	"fsd-mrbs/src/domain/department"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DepartmentRepo struct{ db *pgxpool.Pool }

func NewDepartmentRepo(db *pgxpool.Pool) *DepartmentRepo { return &DepartmentRepo{db: db} }

func (r *DepartmentRepo) List(ctx context.Context, tenantID string) ([]department.Department, error) {
	rows, err := r.db.Query(ctx,
		`SELECT id, tenant_id, name, COALESCE(code,''), COALESCE(parent_id::text,''), created_at, updated_at
         FROM departments WHERE tenant_id = $1 ORDER BY name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []department.Department
	for rows.Next() {
		var d department.Department
		if err := rows.Scan(&d.ID, &d.TenantID, &d.Name, &d.Code, &d.ParentID, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

func (r *DepartmentRepo) GetByID(ctx context.Context, id string) (*department.Department, error) {
	var d department.Department
	err := r.db.QueryRow(ctx,
		`SELECT id, tenant_id, name, COALESCE(code,''), COALESCE(parent_id::text,''), created_at, updated_at
         FROM departments WHERE id = $1`, id,
	).Scan(&d.ID, &d.TenantID, &d.Name, &d.Code, &d.ParentID, &d.CreatedAt, &d.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("department not found")
	}
	if err != nil {
		return nil, err
	}
	return &d, nil
}

func (r *DepartmentRepo) Save(ctx context.Context, d department.Department) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO departments (id, tenant_id, name, code, parent_id)
VALUES ($1, $2, $3, NULLIF($4,''), NULLIF($5,'')::uuid)
ON CONFLICT (id) DO UPDATE
SET name      = EXCLUDED.name,
    code      = EXCLUDED.code,
    parent_id = EXCLUDED.parent_id,
    updated_at = NOW()
`, d.ID, d.TenantID, d.Name, d.Code, d.ParentID)
	return err
}

func (r *DepartmentRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM departments WHERE id = $1`, id)
	return err
}
