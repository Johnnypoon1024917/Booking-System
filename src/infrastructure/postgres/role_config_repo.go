package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/admin"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// roleConfigRepo implements admin.RoleConfigRepository using PostgreSQL
type roleConfigRepo struct {
	db *pgxpool.Pool
}

// NewRoleConfigRepository creates a new role config repository instance
func NewRoleConfigRepository(db *pgxpool.Pool) admin.RoleConfigRepository {
	return &roleConfigRepo{db: db}
}

// GetByID retrieves a role config by its ID
func (r *roleConfigRepo) GetByID(ctx context.Context, id uuid.UUID) (*admin.RoleConfig, error) {
	query := `
		SELECT id, tenant_id, role_name, booking_limit, permissions, is_custom, created_at
		FROM role_configs
		WHERE id = $1
	`

	var config admin.RoleConfig
	var permissionsJSON []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&config.ID,
		&config.TenantID,
		&config.RoleName,
		&config.BookingLimit,
		&permissionsJSON,
		&config.IsCustom,
		&config.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get role config by id: %w", err)
	}

	// Unmarshal permissions JSONB
	if len(permissionsJSON) > 0 && string(permissionsJSON) != "null" {
		json.Unmarshal(permissionsJSON, &config.Permissions)
	}

	return &config, nil
}

// GetByTenantAndName retrieves a role config by tenant ID and role name
func (r *roleConfigRepo) GetByTenantAndName(ctx context.Context, tenantID uuid.UUID, roleName string) (*admin.RoleConfig, error) {
	query := `
		SELECT id, tenant_id, role_name, booking_limit, permissions, is_custom, created_at
		FROM role_configs
		WHERE tenant_id = $1 AND role_name = $2
	`

	var config admin.RoleConfig
	var permissionsJSON []byte

	err := r.db.QueryRow(ctx, query, tenantID, roleName).Scan(
		&config.ID,
		&config.TenantID,
		&config.RoleName,
		&config.BookingLimit,
		&permissionsJSON,
		&config.IsCustom,
		&config.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get role config by tenant and name: %w", err)
	}

	// Unmarshal permissions JSONB
	if len(permissionsJSON) > 0 && string(permissionsJSON) != "null" {
		json.Unmarshal(permissionsJSON, &config.Permissions)
	}

	return &config, nil
}

// ListByTenant retrieves all role configs for a tenant
func (r *roleConfigRepo) ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]admin.RoleConfig, error) {
	query := `
		SELECT id, tenant_id, role_name, booking_limit, permissions, is_custom, created_at
		FROM role_configs
		WHERE tenant_id = $1
		ORDER BY role_name
	`

	rows, err := r.db.Query(ctx, query, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to list role configs: %w", err)
	}
	defer rows.Close()

	var configs []admin.RoleConfig
	for rows.Next() {
		var config admin.RoleConfig
		var permissionsJSON []byte

		err := rows.Scan(
			&config.ID,
			&config.TenantID,
			&config.RoleName,
			&config.BookingLimit,
			&permissionsJSON,
			&config.IsCustom,
			&config.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan role config: %w", err)
		}

		// Unmarshal permissions JSONB
		if len(permissionsJSON) > 0 && string(permissionsJSON) != "null" {
			json.Unmarshal(permissionsJSON, &config.Permissions)
		}

		configs = append(configs, config)
	}

	return configs, nil
}

// Save creates or updates a role config
func (r *roleConfigRepo) Save(ctx context.Context, config admin.RoleConfig) error {
	permissionsJSON, _ := json.Marshal(config.Permissions)

	query := `
		INSERT INTO role_configs (id, tenant_id, role_name, booking_limit, permissions, is_custom, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (id) DO UPDATE
		SET role_name = EXCLUDED.role_name,
			booking_limit = EXCLUDED.booking_limit,
			permissions = EXCLUDED.permissions,
			is_custom = EXCLUDED.is_custom
	`

	_, err := r.db.Exec(ctx, query,
		config.ID,
		config.TenantID,
		config.RoleName,
		config.BookingLimit,
		permissionsJSON,
		config.IsCustom,
		config.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save role config: %w", err)
	}
	return nil
}

// Delete removes a role config by ID
func (r *roleConfigRepo) Delete(ctx context.Context, id uuid.UUID) error {
	query := `DELETE FROM role_configs WHERE id = $1`
	_, err := r.db.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete role config: %w", err)
	}
	return nil
}
