package postgres

import (
	"context"

	"fsd-mrbs/src/domain/permission"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type PermissionCatalogRepo struct {
	db *pgxpool.Pool
}

func NewPermissionCatalogRepo(db *pgxpool.Pool) *PermissionCatalogRepo {
	return &PermissionCatalogRepo{db: db}
}

func (r *PermissionCatalogRepo) ListGroups(ctx context.Context, tenantID string) ([]permission.CustomGroup, error) {
	rows, err := r.db.Query(ctx, `
SELECT id::text, tenant_id::text, key, label, display_order
  FROM permission_catalog_groups
 WHERE tenant_id = $1
 ORDER BY display_order, label`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []permission.CustomGroup
	for rows.Next() {
		var g permission.CustomGroup
		if err := rows.Scan(&g.ID, &g.TenantID, &g.Key, &g.Label, &g.DisplayOrder); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

func (r *PermissionCatalogRepo) ListPermissions(ctx context.Context, tenantID string) ([]permission.CustomPermission, error) {
	rows, err := r.db.Query(ctx, `
SELECT id::text, tenant_id::text, group_key, key, label, COALESCE(description,'')
  FROM permission_catalog_permissions
 WHERE tenant_id = $1
 ORDER BY group_key, label`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []permission.CustomPermission
	for rows.Next() {
		var p permission.CustomPermission
		if err := rows.Scan(&p.ID, &p.TenantID, &p.GroupKey, &p.Key, &p.Label, &p.Description); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

func (r *PermissionCatalogRepo) SaveGroup(ctx context.Context, g permission.CustomGroup) error {
	if g.ID == "" {
		g.ID = uuid.New().String()
	}
	_, err := r.db.Exec(ctx, `
INSERT INTO permission_catalog_groups (id, tenant_id, key, label, display_order, is_builtin)
VALUES ($1, $2, $3, $4, $5, FALSE)
ON CONFLICT (tenant_id, key) DO UPDATE
SET label = EXCLUDED.label,
    display_order = EXCLUDED.display_order`,
		g.ID, g.TenantID, g.Key, g.Label, g.DisplayOrder)
	return err
}

func (r *PermissionCatalogRepo) DeleteGroup(ctx context.Context, tenantID, key string) error {
	_, err := r.db.Exec(ctx, `
DELETE FROM permission_catalog_groups
 WHERE tenant_id = $1 AND key = $2 AND is_builtin = FALSE`, tenantID, key)
	return err
}

func (r *PermissionCatalogRepo) SavePermission(ctx context.Context, p permission.CustomPermission) error {
	if p.ID == "" {
		p.ID = uuid.New().String()
	}
	_, err := r.db.Exec(ctx, `
INSERT INTO permission_catalog_permissions (id, tenant_id, group_key, key, label, description, is_builtin)
VALUES ($1, $2, $3, $4, $5, NULLIF($6,''), FALSE)
ON CONFLICT (tenant_id, key) DO UPDATE
SET group_key = EXCLUDED.group_key,
    label = EXCLUDED.label,
    description = EXCLUDED.description`,
		p.ID, p.TenantID, p.GroupKey, p.Key, p.Label, p.Description)
	return err
}

func (r *PermissionCatalogRepo) DeletePermission(ctx context.Context, tenantID, key string) error {
	_, err := r.db.Exec(ctx, `
DELETE FROM permission_catalog_permissions
 WHERE tenant_id = $1 AND key = $2 AND is_builtin = FALSE`, tenantID, key)
	return err
}
