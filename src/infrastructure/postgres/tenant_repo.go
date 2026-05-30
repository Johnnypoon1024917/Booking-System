package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/tenant"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// TenantRepository defines the interface for tenant data access
type TenantRepository interface {
	GetByID(ctx context.Context, id uuid.UUID) (*tenant.Tenant, error)
	GetByName(ctx context.Context, name string) (*tenant.Tenant, error)
	SetTenantContext(ctx context.Context, tenantID uuid.UUID) error
}

// tenantRepo implements TenantRepository using PostgreSQL
type tenantRepo struct {
	db *pgxpool.Pool
}

// NewTenantRepository creates a new TenantRepository instance
func NewTenantRepository(db *pgxpool.Pool) TenantRepository {
	return &tenantRepo{db: db}
}

// GetByID retrieves a tenant by its unique identifier
func (r *tenantRepo) GetByID(ctx context.Context, id uuid.UUID) (*tenant.Tenant, error) {
	query := `
		SELECT id, name, display_name, status, branding_config, identity_provider_config, approval_config, booking_limits
		FROM tenants
		WHERE id = $1
	`

	var t tenant.Tenant
	var brandingConfig, identityProviderConfig, approvalConfig, bookingLimits []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&t.ID,
		&t.Name,
		&t.DisplayName,
		&t.Status,
		&brandingConfig,
		&identityProviderConfig,
		&approvalConfig,
		&bookingLimits,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get tenant by id: %w", err)
	}

	// Unmarshal JSONB fields
	if len(brandingConfig) > 0 {
		json.Unmarshal(brandingConfig, &t.BrandingConfig)
	}
	if len(identityProviderConfig) > 0 {
		json.Unmarshal(identityProviderConfig, &t.IdentityProviderConfig)
	}
	if len(approvalConfig) > 0 {
		json.Unmarshal(approvalConfig, &t.ApprovalConfig)
	}
	if len(bookingLimits) > 0 {
		json.Unmarshal(bookingLimits, &t.BookingLimits)
	}

	return &t, nil
}

// GetByName retrieves a tenant by its name
func (r *tenantRepo) GetByName(ctx context.Context, name string) (*tenant.Tenant, error) {
	query := `
		SELECT id, name, display_name, status, branding_config, identity_provider_config, approval_config, booking_limits
		FROM tenants
		WHERE name = $1
	`

	var t tenant.Tenant
	var brandingConfig, identityProviderConfig, approvalConfig, bookingLimits []byte

	err := r.db.QueryRow(ctx, query, name).Scan(
		&t.ID,
		&t.Name,
		&t.DisplayName,
		&t.Status,
		&brandingConfig,
		&identityProviderConfig,
		&approvalConfig,
		&bookingLimits,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get tenant by name: %w", err)
	}

	// Unmarshal JSONB fields
	if len(brandingConfig) > 0 {
		json.Unmarshal(brandingConfig, &t.BrandingConfig)
	}
	if len(identityProviderConfig) > 0 {
		json.Unmarshal(identityProviderConfig, &t.IdentityProviderConfig)
	}
	if len(approvalConfig) > 0 {
		json.Unmarshal(approvalConfig, &t.ApprovalConfig)
	}
	if len(bookingLimits) > 0 {
		json.Unmarshal(bookingLimits, &t.BookingLimits)
	}

	return &t, nil
}

// SetTenantContext sets the app.current_tenant_id session variable used by
// RLS policies as a defence-in-depth layer.
//
// IMPORTANT: pgxpool hands a different connection to each query and
// `set_config(..., is_local := true)` is transaction-scoped, so a value
// set here does NOT persist across subsequent statements on the same
// request. RLS based on this setting is therefore best-effort only.
//
// The PRIMARY tenant boundary is the explicit `WHERE tenant_id = $1`
// predicate that every repository query already carries; this function
// exists to (1) attempt to set the variable for any in-transaction queries
// that immediately follow, and (2) preserve a hook we can later upgrade to
// proper per-request connection pinning without changing call sites.
//
// The query is parameterised via set_config to remove the previous
// SQL-string interpolation pattern.
func (r *tenantRepo) SetTenantContext(ctx context.Context, tenantID uuid.UUID) error {
	_, err := r.db.Exec(ctx, "SELECT set_config('app.current_tenant_id', $1, true)", tenantID.String())
	if err != nil {
		return fmt.Errorf("failed to set tenant context: %w", err)
	}
	return nil
}
