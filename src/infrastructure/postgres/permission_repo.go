package postgres

import (
	"context"

	"fsd-mrbs/src/domain/permission"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PermissionRepo persists per-tenant role permissions in the
// role_permissions table introduced in migration 007.
type PermissionRepo struct{ db *pgxpool.Pool }

func NewPermissionRepo(db *pgxpool.Pool) *PermissionRepo { return &PermissionRepo{db: db} }

func (r *PermissionRepo) Get(ctx context.Context, tenantID string) (*permission.RoleMatrix, error) {
	rows, err := r.db.Query(ctx,
		`SELECT role, permissions FROM role_permissions WHERE tenant_id = $1 ORDER BY role`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &permission.RoleMatrix{TenantID: tenantID, Roles: map[string][]string{}}
	for rows.Next() {
		var role string
		var perms []string
		if err := rows.Scan(&role, &perms); err != nil {
			return nil, err
		}
		out.Roles[role] = perms
	}
	return out, nil
}

func (r *PermissionRepo) Set(ctx context.Context, tenantID, role string, permissions []string) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO role_permissions (tenant_id, role, permissions)
VALUES ($1, $2, $3)
ON CONFLICT (tenant_id, role) DO UPDATE
SET permissions = EXCLUDED.permissions, updated_at = NOW()`,
		tenantID, role, permissions)
	return err
}
