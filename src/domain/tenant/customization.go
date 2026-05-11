package tenant

import (
	"context"
	"errors"

	"github.com/google/uuid"
)

// Customization holds the tenant-driven configuration that turns this
// platform into a branded product for each customer (FSD, etc.).
//
// Every visible piece of UI text, color, role label, weekend rule, holiday
// list, and notification template is sourced from here so the same binary
// can serve any organization without code changes.
type Customization struct {
	TenantID uuid.UUID

	// --- Branding ---
	BrandName       string // e.g., "FSD MRBS" or "Acme Rooms"
	BrandLogoURL    string
	BrandPrimary    string // hex, e.g., "#002147"
	BrandSecondary  string
	BrandAccent     string

	// --- Localization ---
	DefaultLocale     string   // "en", "zh-Hant", "zh-Hans"
	AvailableLocales  []string // subset of supported locales
	Timezone          string   // IANA, e.g., "Asia/Hong_Kong"

	// --- Layout ---
	// Dashboard widgets to show, in display order. Known keys are interpreted
	// by the SPA (kpi-active, kpi-utilisation, kpi-pending, calendar-week,
	// recent-bookings, broadcast-banner, my-approvals, no-show-list).
	DashboardWidgets []string
	// Sidebar nav entries: tenants can hide modules they don't license.
	SidebarModules []string

	// --- Workflow ---
	WeekendDays            []int  // ISO 8601: Mon=1..Sun=7
	BookingHorizonDays     int    // how far in advance bookings allowed
	MinDurationMinutes     int
	MaxDurationMinutes     int
	GracePeriodMinutes     int    // for auto-no-show
	ApprovalWindowHours    int    // approver SLA before auto-escalate
	WeekendRequireApproval bool
	HolidayBlocking        bool

	// --- Custom fields (per-booking metadata captured in UI) ---
	// Each entry produces a form field on the booking modal.
	CustomFields []CustomField

	// --- Roles ---
	// Display names for built-in roles; permission grants for custom roles
	// live in role_configs (already modeled).
	RoleLabels map[string]string

	// --- Integrations ---
	HKOWeatherEnabled  bool   // auto-mark exceptions on T8/Black Rain
	GovHKHolidayFeed   bool   // nightly import from gov.hk ICS
	OutlookSyncEnabled bool
	TeamsAppEnabled    bool
	ZoomMaskBase       string // e.g., "https://ess.hkfsd.hksarg/redirect"
}

// CustomField defines a tenant-configured input on the booking form.
type CustomField struct {
	Key         string   // stable machine key, e.g., "purpose_code"
	Label       map[string]string // localized labels keyed by locale
	Type        string   // "text" | "select" | "number" | "checkbox" | "date"
	Required    bool
	Options     []string // for select
	HelpText    map[string]string
}

// Repository persists tenant customization documents.
type Repository interface {
	Get(ctx context.Context, tenantID uuid.UUID) (*Customization, error)
	Save(ctx context.Context, c *Customization) error
}

// Validate enforces sane defaults and limits before persistence.
func (c *Customization) Validate() error {
	if c.TenantID == uuid.Nil {
		return errors.New("tenant id required")
	}
	if c.DefaultLocale == "" {
		c.DefaultLocale = "en"
	}
	if c.Timezone == "" {
		c.Timezone = "Asia/Hong_Kong"
	}
	if len(c.AvailableLocales) == 0 {
		c.AvailableLocales = []string{"en", "zh-Hant", "zh-Hans"}
	}
	if c.BookingHorizonDays <= 0 {
		c.BookingHorizonDays = 90
	}
	if c.MinDurationMinutes <= 0 {
		c.MinDurationMinutes = 15
	}
	if c.MaxDurationMinutes <= 0 {
		c.MaxDurationMinutes = 8 * 60
	}
	if c.GracePeriodMinutes <= 0 {
		c.GracePeriodMinutes = 15
	}
	if c.ApprovalWindowHours <= 0 {
		c.ApprovalWindowHours = 24
	}
	if c.RoleLabels == nil {
		c.RoleLabels = map[string]string{}
	}
	if len(c.DashboardWidgets) == 0 {
		c.DashboardWidgets = []string{
			"kpi-active", "kpi-utilisation", "kpi-pending",
			"calendar-week", "recent-bookings", "broadcast-banner",
		}
	}
	if len(c.SidebarModules) == 0 {
		c.SidebarModules = []string{"dashboard", "search", "my-bookings", "approvals", "reports", "admin"}
	}
	if len(c.WeekendDays) == 0 {
		c.WeekendDays = []int{6, 7} // Sat, Sun
	}
	for _, f := range c.CustomFields {
		if f.Key == "" {
			return errors.New("custom field key required")
		}
		if f.Type == "" {
			return errors.New("custom field type required for key " + f.Key)
		}
	}
	return nil
}

// FSDDefaults returns a Customization preconfigured for the Hong Kong Fire
// Services Department. Used during tenant provisioning so FSD admins start
// with a sensible baseline they can refine in the admin UI.
func FSDDefaults(tenantID uuid.UUID) *Customization {
	return &Customization{
		TenantID:               tenantID,
		BrandName:              "FSD Resource Booking",
		BrandPrimary:           "#002147",
		BrandSecondary:         "#D71920",
		BrandAccent:            "#FFD700",
		DefaultLocale:          "en",
		AvailableLocales:       []string{"en", "zh-Hant", "zh-Hans"},
		Timezone:               "Asia/Hong_Kong",
		WeekendDays:            []int{6, 7},
		BookingHorizonDays:     180,
		MinDurationMinutes:     15,
		MaxDurationMinutes:     8 * 60,
		GracePeriodMinutes:     15,
		ApprovalWindowHours:    24,
		WeekendRequireApproval: true,
		HolidayBlocking:        true,
		HKOWeatherEnabled:      true,
		GovHKHolidayFeed:       true,
		ZoomMaskBase:           "https://ess.hkfsd.hksarg/redirect",
		RoleLabels: map[string]string{
			"System Admin":   "System Admin",
			"Security Admin": "Security Admin",
			"Room Admin":     "Room Admin",
			"General User":   "General User",
			"Secretary":      "Secretary (SDO)",
		},
		CustomFields: []CustomField{
			{
				Key:      "purpose_code",
				Type:     "select",
				Required: true,
				Options:  []string{"Operational", "Training", "Briefing", "VIP"},
				Label: map[string]string{
					"en":      "Purpose",
					"zh-Hant": "用途",
					"zh-Hans": "用途",
				},
			},
			{
				Key:  "attendee_count",
				Type: "number",
				Label: map[string]string{
					"en":      "Expected Attendees",
					"zh-Hant": "預計出席人數",
					"zh-Hans": "预计出席人数",
				},
			},
		},
	}
}
