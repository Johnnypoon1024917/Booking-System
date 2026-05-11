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

// SetTenantContext sets the app.current_tenant_id session variable for row-level security
// This MUST be called before any tenant-scoped database operations
func (r *tenantRepo) SetTenantContext(ctx context.Context, tenantID uuid.UUID) error {
	// Execute SET LOCAL to set the tenant context for the current session/transaction
	// Using SET LOCAL ensures it only affects the current transaction
	query := fmt.Sprintf("SET LOCAL app.current_tenant_id = '%s'", tenantID.String())
	_, err := r.db.Exec(ctx, query)
	if err != nil {
		return fmt.Errorf("failed to set tenant context: %w", err)
	}
	return nil
}
