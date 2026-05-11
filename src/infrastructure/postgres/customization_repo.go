package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"fsd-mrbs/src/domain/tenant"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// CustomizationRepo persists tenant.Customization in a JSONB column on the
// tenants table. We piggyback on the existing tenants table rather than
// creating a new one so multi-tenant RLS stays in one place.
type CustomizationRepo struct {
	pool *pgxpool.Pool
}

func NewCustomizationRepo(pool *pgxpool.Pool) *CustomizationRepo {
	return &CustomizationRepo{pool: pool}
}

const customizationColumn = "customization_config"

// Get loads the customization document for a tenant. If no document exists
// yet (newly provisioned tenant), it returns nil with no error so callers
// can fall back to FSDDefaults / generic defaults.
func (r *CustomizationRepo) Get(ctx context.Context, tenantID uuid.UUID) (*tenant.Customization, error) {
	if tenantID == uuid.Nil {
		return nil, errors.New("tenant id required")
	}
	var raw []byte
	err := r.pool.QueryRow(ctx,
		`SELECT COALESCE(customization_config::text, '')::bytea FROM tenants WHERE id = $1`,
		tenantID,
	).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	var c tenant.Customization
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, err
	}
	c.TenantID = tenantID
	return &c, nil
}

// Save upserts the customization JSON onto the tenant row.
func (r *CustomizationRepo) Save(ctx context.Context, c *tenant.Customization) error {
	if c == nil {
		return errors.New("customization required")
	}
	if err := c.Validate(); err != nil {
		return err
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = r.pool.Exec(ctx,
		`UPDATE tenants SET customization_config = $1::jsonb, updated_at = NOW() WHERE id = $2`,
		raw, c.TenantID,
	)
	return err
}
