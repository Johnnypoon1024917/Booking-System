package postgres

import (
	"context"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/user"
	"fsd-mrbs/src/infrastructure/dbctx"

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
	// SetPassword stores a fresh bcrypt hash and clears must_change_password.
	// Used by the forced first-login reset flow.
	SetPassword(ctx context.Context, userID, passwordHash string) error
	// SetDepartmentIDs replaces the user's department membership with
	// exactly the supplied list. Pass an empty slice to clear all
	// memberships. tenantID is required so the inserted join rows
	// satisfy the RLS policy on user_departments.
	SetDepartmentIDs(ctx context.Context, tenantID, userID string, departmentIDs []string) error
}

// userRepo implements UserRepository using PostgreSQL
type userRepo struct {
	db *pgxpool.Pool
}

func (r *userRepo) exec(ctx context.Context) dbctx.Executor {
	return dbctx.ExecutorFromContext(ctx, r.db)
}

// NewUserRepository creates a new UserRepository instance.
// All statements route through dbctx.ExecutorFromContext so requests
// wrapped by WithTenantTx run under per-request RLS; the login flow
// queries without the middleware and uses the pool path (the users
// policy admits rows when app.current_tenant_id is unset, allowing the
// tenant to be resolved from the user row before scope is established).
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

	err := r.exec(ctx).QueryRow(ctx, query, id).Scan(
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
	u.DepartmentIDs, _ = r.departmentsForUser(ctx, id)
	return &u, nil
}

// departmentsForUser pulls the join rows for one user. Errors are
// swallowed by the callers (returned via `_`) because a missing
// membership list shouldn't fail the whole user fetch — empty slice is
// the right fallback.
func (r *userRepo) departmentsForUser(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.exec(ctx).Query(ctx,
		`SELECT department_id::text FROM user_departments WHERE user_id = $1`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			out = append(out, id)
		}
	}
	return out, nil
}

// GetByUsername retrieves a user by tenant and username
func (r *userRepo) GetByUsername(ctx context.Context, tenantID, username string) (*user.User, error) {
	query := `
		SELECT id, tenant_id, username, COALESCE(dn,''), role, COALESCE(grade,''), is_active, region_access,
		       COALESCE(password_hash,''), COALESCE(must_change_password, FALSE), COALESCE(last_sync_at, NOW())
		FROM users
		WHERE tenant_id = $1 AND username = $2
	`

	var u user.User
	var regionAccess []string

	err := r.exec(ctx).QueryRow(ctx, query, tenantID, username).Scan(
		&u.ID,
		&u.TenantID,
		&u.Username,
		&u.DN,
		&u.Role,
		&u.Grade,
		&u.IsActive,
		&regionAccess,
		&u.PasswordHash,
		&u.MustChangePassword,
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
	// password_hash is preserved on conflict when the incoming hash is empty
	// — the AD/SSO upsert-on-login path calls Save with no hash and must not
	// wipe a local password an admin set. must_change_password is written
	// straight through (admin create/edit owns that flag; AD users carry the
	// default FALSE).
	query := `
		INSERT INTO users (id, tenant_id, username, dn, role, grade, is_active, region_access, password_hash, must_change_password, created_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9, ''), $10, $11)
		ON CONFLICT (tenant_id, username) DO UPDATE
		SET dn = EXCLUDED.dn,
			role = EXCLUDED.role,
			grade = EXCLUDED.grade,
			is_active = EXCLUDED.is_active,
			region_access = EXCLUDED.region_access,
			password_hash = COALESCE(NULLIF(EXCLUDED.password_hash, ''), users.password_hash),
			must_change_password = EXCLUDED.must_change_password,
			updated_at = CURRENT_TIMESTAMP
	`

	_, err := r.exec(ctx).Exec(ctx, query,
		u.ID,
		u.TenantID,
		u.Username,
		u.DN,
		u.Role,
		u.Grade,
		u.IsActive,
		u.RegionAccess,
		u.PasswordHash,
		u.MustChangePassword,
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

	rows, err := r.exec(ctx).Query(ctx, query, tenantID)
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

	// Fold in department memberships in a single follow-up query —
	// avoids N+1 trips against user_departments when the page renders
	// the whole admin user list.
	if len(users) > 0 {
		memb, err := r.departmentsByTenant(ctx, tenantID)
		if err == nil {
			for i := range users {
				users[i].DepartmentIDs = memb[users[i].ID]
			}
		}
	}
	return users, nil
}

// departmentsByTenant returns a userID → []departmentID map for every
// membership row in the tenant. Single query that the list path uses
// to populate DepartmentIDs in O(N) instead of one query per user.
func (r *userRepo) departmentsByTenant(ctx context.Context, tenantID string) (map[string][]string, error) {
	rows, err := r.exec(ctx).Query(ctx,
		`SELECT user_id::text, department_id::text
		   FROM user_departments
		  WHERE tenant_id = $1`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string][]string{}
	for rows.Next() {
		var uid, did string
		if err := rows.Scan(&uid, &did); err == nil {
			out[uid] = append(out[uid], did)
		}
	}
	return out, nil
}

// UpdateSyncTimestamp updates the last sync timestamp for a user
func (r *userRepo) UpdateSyncTimestamp(ctx context.Context, userID string, syncAt time.Time) error {
	query := `UPDATE users SET last_sync_at = $1 WHERE id = $2`
	_, err := r.exec(ctx).Exec(ctx, query, syncAt, userID)
	if err != nil {
		return fmt.Errorf("failed to update sync timestamp: %w", err)
	}
	return nil
}

// SetActive sets the active status of a user
func (r *userRepo) SetActive(ctx context.Context, userID string, isActive bool) error {
	query := `UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
	_, err := r.exec(ctx).Exec(ctx, query, isActive, userID)
	if err != nil {
		return fmt.Errorf("failed to set user active status: %w", err)
	}
	return nil
}

// SetPassword stores a fresh bcrypt hash and clears the force-change flag.
func (r *userRepo) SetPassword(ctx context.Context, userID, passwordHash string) error {
	query := `UPDATE users SET password_hash = $1, must_change_password = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
	_, err := r.exec(ctx).Exec(ctx, query, passwordHash, userID)
	if err != nil {
		return fmt.Errorf("failed to set user password: %w", err)
	}
	return nil
}

// SetDepartmentIDs replaces the user's department membership with the
// supplied list. Implemented as DELETE + bulk INSERT inside the
// caller's request transaction (dbctx.ExecutorFromContext) so the
// change is atomic relative to anything else in the same request — a
// failed insert rolls the whole thing back. Pass an empty slice to
// clear all memberships.
//
// Security: every supplied department_id is intersected with the
// `departments` table filtered by tenant_id BEFORE the inserts, so a
// caller can't attach another tenant's department UUID to a user.
// RLS on user_departments (migration 033) provides defence-in-depth
// via WITH CHECK, but the application validation gives a clear error
// instead of a silent row-skip when the policy rejects a write.
func (r *userRepo) SetDepartmentIDs(ctx context.Context, tenantID, userID string, departmentIDs []string) error {
	ex := r.exec(ctx)

	// Dedupe up front so we can validate / insert from a single set.
	wanted := map[string]struct{}{}
	for _, d := range departmentIDs {
		if d != "" {
			wanted[d] = struct{}{}
		}
	}

	// Cross-tenant safety: intersect with departments rows the tenant
	// actually owns. Any ID the caller supplied that doesn't belong
	// to this tenant is silently dropped — we don't 404 because the
	// caller might be sending a stale ID from a deleted department,
	// and the silent drop also frustrates UUID-guessing probes.
	allowed := map[string]struct{}{}
	if len(wanted) > 0 {
		ids := make([]string, 0, len(wanted))
		for d := range wanted {
			ids = append(ids, d)
		}
		rows, err := ex.Query(ctx,
			`SELECT id::text FROM departments WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
			tenantID, ids)
		if err != nil {
			return fmt.Errorf("validate department tenancy: %w", err)
		}
		for rows.Next() {
			var id string
			if rows.Scan(&id) == nil {
				allowed[id] = struct{}{}
			}
		}
		rows.Close()
	}

	if _, err := ex.Exec(ctx, `DELETE FROM user_departments WHERE user_id = $1`, userID); err != nil {
		return fmt.Errorf("clear user departments: %w", err)
	}
	for d := range allowed {
		if _, err := ex.Exec(ctx, `
			INSERT INTO user_departments (user_id, department_id, tenant_id)
			VALUES ($1, $2, $3)
			ON CONFLICT DO NOTHING`, userID, d, tenantID); err != nil {
			return fmt.Errorf("add user department %s: %w", d, err)
		}
	}
	return nil
}
