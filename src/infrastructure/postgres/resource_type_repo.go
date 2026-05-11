package postgres

import (
	"context"
	"errors"

	"fsd-mrbs/src/domain/resourcetype"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ResourceTypeRepo struct {
	db *pgxpool.Pool
}

func NewResourceTypeRepo(db *pgxpool.Pool) *ResourceTypeRepo {
	return &ResourceTypeRepo{db: db}
}

func (r *ResourceTypeRepo) List(ctx context.Context, tenantID string) ([]resourcetype.ResourceType, error) {
	rows, err := r.db.Query(ctx, `
SELECT id::text, tenant_id::text, key, label, COALESCE(icon,''), COALESCE(color,''),
       default_capacity, default_booking_mode, default_requires_approval,
       display_order, is_builtin, is_active
  FROM resource_types
 WHERE tenant_id = $1
 ORDER BY display_order, label`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []resourcetype.ResourceType
	for rows.Next() {
		var t resourcetype.ResourceType
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Key, &t.Label, &t.Icon, &t.Color,
			&t.DefaultCapacity, &t.DefaultBookingMode, &t.DefaultRequiresApproval,
			&t.DisplayOrder, &t.IsBuiltin, &t.IsActive); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (r *ResourceTypeRepo) Get(ctx context.Context, tenantID, key string) (*resourcetype.ResourceType, error) {
	var t resourcetype.ResourceType
	err := r.db.QueryRow(ctx, `
SELECT id::text, tenant_id::text, key, label, COALESCE(icon,''), COALESCE(color,''),
       default_capacity, default_booking_mode, default_requires_approval,
       display_order, is_builtin, is_active
  FROM resource_types
 WHERE tenant_id = $1 AND key = $2`, tenantID, key).Scan(
		&t.ID, &t.TenantID, &t.Key, &t.Label, &t.Icon, &t.Color,
		&t.DefaultCapacity, &t.DefaultBookingMode, &t.DefaultRequiresApproval,
		&t.DisplayOrder, &t.IsBuiltin, &t.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// Save upserts on (tenant_id, key). Built-in flag is preserved on update.
func (r *ResourceTypeRepo) Save(ctx context.Context, t resourcetype.ResourceType) error {
	if t.ID == "" {
		t.ID = uuid.New().String()
	}
	if t.DefaultBookingMode == "" {
		t.DefaultBookingMode = "exclusive"
	}
	_, err := r.db.Exec(ctx, `
INSERT INTO resource_types (id, tenant_id, key, label, icon, color,
                            default_capacity, default_booking_mode, default_requires_approval,
                            display_order, is_builtin, is_active)
VALUES ($1, $2, $3, $4, NULLIF($5,''), NULLIF($6,''), $7, $8, $9, $10, $11, $12)
ON CONFLICT (tenant_id, key) DO UPDATE
SET label = EXCLUDED.label,
    icon  = EXCLUDED.icon,
    color = EXCLUDED.color,
    default_capacity = EXCLUDED.default_capacity,
    default_booking_mode = EXCLUDED.default_booking_mode,
    default_requires_approval = EXCLUDED.default_requires_approval,
    display_order = EXCLUDED.display_order,
    is_active = EXCLUDED.is_active,
    updated_at = NOW()`,
		t.ID, t.TenantID, t.Key, t.Label, t.Icon, t.Color,
		t.DefaultCapacity, t.DefaultBookingMode, t.DefaultRequiresApproval,
		t.DisplayOrder, t.IsBuiltin, t.IsActive)
	return err
}

// Delete refuses to remove built-in types — they're seeded for every tenant
// and removing them would orphan resources that point to those keys.
func (r *ResourceTypeRepo) Delete(ctx context.Context, tenantID, key string) error {
	_, err := r.db.Exec(ctx, `
DELETE FROM resource_types
 WHERE tenant_id = $1 AND key = $2 AND is_builtin = FALSE`, tenantID, key)
	return err
}
