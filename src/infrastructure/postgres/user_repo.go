package postgres

import (
	"context"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/user"

	"github.com/jackc/pgx/v5/pgxpool"
)

// UserRepository defines the interface for user data access
type UserRepository interface {
	GetByID(ctx context.Context, id string) (*user.User, error)
	GetByUsername(ctx context.Context, tenantID, username string) (*user.User, error)
	Save(ctx context.Context, u user.User) error
	ListByTenant(ctx context.Context, tenantID string) ([]user.User, error)
	UpdateSyncTimestamp(ctx context.Context, userID string, syncAt time.Time) error
	SetActive(ctx context.Context, userID string, isActive bool) error
}

// userRepo implements UserRepository using PostgreSQL
type userRepo struct {
	db *pgxpool.Pool
}

// NewUserRepository creates a new UserRepository instance
func NewUserRepository(db *pgxpool.Pool) UserRepository {
	return &userRepo{db: db}
}

// GetByID retrieves a user by their unique identifier
func (r *userRepo) GetByID(ctx context.Context, id string) (*user.User, error) {
	// COALESCE on dn/grade because SCIM-provisioned users and seed rows
	// may leave them NULL — pgx refuses NULL → *string scans.
	query := `
		SELECT id, tenant_id, username, COALESCE(dn,''), role, COALESCE(grade,''), is_active, region_access, COALESCE(last_sync_at, NOW())
		FROM users
		WHERE id = $1
	`

	var u user.User
	var regionAccess []string

	err := r.db.QueryRow(ctx, query, id).Scan(
		&u.ID,
		&u.TenantID,
		&u.Username,
		&u.DN,
		&u.Role,
		&u.Grade,
		&u.IsActive,
		&regionAccess,
		new(time.Time), // last_sync_at (not in domain model yet)
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get user by id: %w", err)
	}

	u.RegionAccess = regionAccess
	return &u, nil
}

// GetByUsername retrieves a user by tenant and username
func (r *userRepo) GetByUsername(ctx context.Context, tenantID, username string) (*user.User, error) {
	query := `
		SELECT id, tenant_id, username, COALESCE(dn,''), role, COALESCE(grade,''), is_active, region_access, COALESCE(last_sync_at, NOW())
		FROM users
		WHERE tenant_id = $1 AND username = $2
	`

	var u user.User
	var regionAccess []string

	err := r.db.QueryRow(ctx, query, tenantID, username).Scan(
		&u.ID,
		&u.TenantID,
		&u.Username,
		&u.DN,
		&u.Role,
		&u.Grade,
		&u.IsActive,
		&regionAccess,
		new(time.Time),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get user by username: %w", err)
	}

	u.RegionAccess = regionAccess
	return &u, nil
}

// Save creates or updates a user
func (r *userRepo) Save(ctx context.Context, u user.User) error {
	query := `
		INSERT INTO users (id, tenant_id, username, dn, role, grade, is_active, region_access, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		ON CONFLICT (tenant_id, username) DO UPDATE
		SET dn = EXCLUDED.dn,
			role = EXCLUDED.role,
			grade = EXCLUDED.grade,
			is_active = EXCLUDED.is_active,
			region_access = EXCLUDED.region_access,
			updated_at = CURRENT_TIMESTAMP
	`

	_, err := r.db.Exec(ctx, query,
		u.ID,
		u.TenantID,
		u.Username,
		u.DN,
		u.Role,
		u.Grade,
		u.IsActive,
		u.RegionAccess,
		time.Now(),
	)
	if err != nil {
		return fmt.Errorf("failed to save user: %w", err)
	}
	return nil
}

// ListByTenant retrieves all users for a tenant
func (r *userRepo) ListByTenant(ctx context.Context, tenantID string) ([]user.User, error) {
	query := `
		SELECT id, tenant_id, username, COALESCE(dn,''), role, COALESCE(grade,''), is_active, region_access
		FROM users
		WHERE tenant_id = $1
		ORDER BY username
	`

	rows, err := r.db.Query(ctx, query, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer rows.Close()

	var users []user.User
	for rows.Next() {
		var u user.User
		var regionAccess []string

		err := rows.Scan(
			&u.ID,
			&u.TenantID,
			&u.Username,
			&u.DN,
			&u.Role,
			&u.Grade,
			&u.IsActive,
			&regionAccess,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}

		u.RegionAccess = regionAccess
		users = append(users, u)
	}

	return users, nil
}

// UpdateSyncTimestamp updates the last sync timestamp for a user
func (r *userRepo) UpdateSyncTimestamp(ctx context.Context, userID string, syncAt time.Time) error {
	query := `UPDATE users SET last_sync_at = $1 WHERE id = $2`
	_, err := r.db.Exec(ctx, query, syncAt, userID)
	if err != nil {
		return fmt.Errorf("failed to update sync timestamp: %w", err)
	}
	return nil
}

// SetActive sets the active status of a user
func (r *userRepo) SetActive(ctx context.Context, userID string, isActive bool) error {
	query := `UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
	_, err := r.db.Exec(ctx, query, isActive, userID)
	if err != nil {
		return fmt.Errorf("failed to set user active status: %w", err)
	}
	return nil
}
