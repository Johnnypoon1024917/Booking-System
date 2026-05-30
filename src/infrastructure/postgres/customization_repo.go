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
	// A row written by a previous build used PascalCase JSON keys, so the
	// snake_case unmarshal above yields an all-zero document. Re-read it
	// through the legacy shape and migrate, instead of losing the tenant's
	// configuration.
	if c.BrandName == "" && c.DefaultLocale == "" && len(c.SidebarModules) == 0 {
		var legacy legacyCustomization
		if err := json.Unmarshal(raw, &legacy); err == nil && (legacy.BrandName != "" || legacy.DefaultLocale != "" || len(legacy.SidebarModules) > 0) {
			c = legacy.toCurrent()
		} else {
			// Genuinely empty → let the caller fall back to FSDDefaults.
			return nil, nil
		}
	}
	c.TenantID = tenantID
	return &c, nil
}

// legacyCustomization mirrors the pre-redesign on-disk shape (Go default
// PascalCase JSON keys, no tags). It exists only so an old row migrates
// forward on first read; once Save() runs the row is rewritten snake_case.
type legacyCustomization struct {
	BrandName              string
	BrandLogoURL           string
	BrandPrimary           string
	BrandSecondary         string
	BrandAccent            string
	DefaultLocale          string
	AvailableLocales       []string
	Timezone               string
	DashboardWidgets       []string
	SidebarModules         []string
	WeekendDays            []int
	BookingHorizonDays     int
	MinDurationMinutes     int
	MaxDurationMinutes     int
	GracePeriodMinutes     int
	ApprovalWindowHours    int
	WeekendRequireApproval bool
	HolidayBlocking        bool
	CustomFields           []tenant.CustomField
	RoleLabels             map[string]string
	HKOWeatherEnabled      bool
	GovHKHolidayFeed       bool
	OutlookSyncEnabled     bool
	TeamsAppEnabled        bool
	ZoomMaskBase           string
}

func (l legacyCustomization) toCurrent() tenant.Customization {
	return tenant.Customization{
		BrandName:              l.BrandName,
		BrandLogoURL:           l.BrandLogoURL,
		BrandPrimary:           l.BrandPrimary,
		BrandSecondary:         l.BrandSecondary,
		BrandAccent:            l.BrandAccent,
		DefaultLocale:          l.DefaultLocale,
		AvailableLocales:       l.AvailableLocales,
		Timezone:               l.Timezone,
		DashboardWidgets:       l.DashboardWidgets,
		SidebarModules:         l.SidebarModules,
		WeekendDays:            l.WeekendDays,
		BookingHorizonDays:     l.BookingHorizonDays,
		MinDurationMinutes:     l.MinDurationMinutes,
		MaxDurationMinutes:     l.MaxDurationMinutes,
		GracePeriodMinutes:     l.GracePeriodMinutes,
		ApprovalWindowHours:    l.ApprovalWindowHours,
		WeekendRequireApproval: l.WeekendRequireApproval,
		HolidayBlocking:        l.HolidayBlocking,
		CustomFields:           l.CustomFields,
		RoleLabels:             l.RoleLabels,
		HKOWeatherEnabled:      l.HKOWeatherEnabled,
		GovHKHolidayFeed:       l.GovHKHolidayFeed,
		OutlookSyncEnabled:     l.OutlookSyncEnabled,
		TeamsAppEnabled:        l.TeamsAppEnabled,
		ZoomMaskBase:           l.ZoomMaskBase,
	}
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
