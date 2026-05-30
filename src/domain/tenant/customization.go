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
// JSON is serialised as snake_case so the API contract matches the SPA
// (Admin settings screen, branding boot, sidebar/dashboard layout). The
// same shape is stored in the customization JSONB column.
type Customization struct {
	TenantID uuid.UUID `json:"tenant_id"`

	// --- Branding ---
	BrandName      string `json:"brand_name"` // e.g., "FSD MRBS" or "Acme Rooms"
	BrandLogoURL   string `json:"brand_logo_url"`
	BrandPrimary   string `json:"brand_primary"` // hex, e.g., "#002147"
	BrandSecondary string `json:"brand_secondary"`
	BrandAccent    string `json:"brand_accent"`

	// --- Localization ---
	DefaultLocale    string   `json:"default_locale"`    // "en", "zh-Hant", "zh-Hans"
	AvailableLocales []string `json:"available_locales"` // subset of supported locales
	Timezone         string   `json:"timezone"`          // IANA, e.g., "Asia/Hong_Kong"

	// --- Layout ---
	// Dashboard widgets to show, in display order. Known keys are interpreted
	// by the SPA (kpi-active, kpi-utilisation, kpi-pending, calendar-week,
	// recent-bookings, broadcast-banner, my-approvals, no-show-list).
	DashboardWidgets []string `json:"dashboard_widgets"`
	// Sidebar nav entries: tenants can hide modules they don't license.
	SidebarModules []string `json:"sidebar_modules"`
	// Calendar grid working hours (24h). The Calendar View and the
	// New Booking week grid render rows from start..end inclusive.
	CalendarStartHour int `json:"calendar_start_hour"`
	CalendarEndHour   int `json:"calendar_end_hour"`
	// Report templates the tenant exposes on the Reports screen. Keys:
	// audit, summary, noshow, staff, usage, medical, addl.
	ReportTypes []string `json:"report_types"`
	// Recurrence patterns offered in booking forms. Keys:
	// daily, weekly, monthly, weekday.
	RecurrencePatterns []string `json:"recurrence_patterns"`
	// Weather-driven automatic broadcast rules. The scheduler polls HKO
	// and auto-publishes the configured banner when a rule matches.
	BroadcastAutoRules []BroadcastAutoRule `json:"broadcast_auto_rules"`

	// --- Workflow ---
	WeekendDays            []int `json:"weekend_days"` // ISO 8601: Mon=1..Sun=7
	BookingHorizonDays     int   `json:"booking_horizon_days"`
	MinDurationMinutes     int   `json:"min_duration_minutes"`
	MaxDurationMinutes     int   `json:"max_duration_minutes"`
	GracePeriodMinutes     int   `json:"grace_period_minutes"` // for auto-no-show
	ApprovalWindowHours    int   `json:"approval_window_hours"`
	WeekendRequireApproval bool  `json:"weekend_require_approval"`
	HolidayBlocking        bool  `json:"holiday_blocking"`

	// --- Custom fields (per-booking metadata captured in UI) ---
	// Each entry produces a form field on the booking modal.
	CustomFields []CustomField `json:"custom_fields"`

	// --- Roles ---
	// Display names for built-in roles; permission grants for custom roles
	// live in role_configs (already modeled).
	RoleLabels map[string]string `json:"role_labels"`

	// --- Integrations ---
	HKOWeatherEnabled  bool   `json:"hko_weather_enabled"` // auto-mark exceptions on T8/Black Rain
	GovHKHolidayFeed   bool   `json:"gov_hk_holiday_feed"` // nightly import from gov.hk ICS
	OutlookSyncEnabled bool   `json:"outlook_sync_enabled"`
	TeamsAppEnabled    bool   `json:"teams_app_enabled"`
	ZoomMaskBase       string `json:"zoom_mask_base"` // e.g., "https://ess.hkfsd.hksarg/redirect"
}

// CustomField defines a tenant-configured input on the booking form.
type CustomField struct {
	Key      string            `json:"key"` // stable machine key, e.g., "purpose_code"
	Label    map[string]string `json:"label"`
	Type     string            `json:"type"` // "text" | "select" | "number" | "checkbox" | "date"
	Required bool              `json:"required"`
	Options  []string          `json:"options"`
	HelpText map[string]string `json:"help_text"`
}

// BroadcastAutoRule auto-publishes a banner when a weather condition is
// met, with no admin action. Evaluated by the scheduler every 5 minutes.
type BroadcastAutoRule struct {
	ID            string  `json:"id"`
	Enabled       bool    `json:"enabled"`
	Metric        string  `json:"metric"`    // temp_above | temp_below | signal_at_least
	Threshold     float64 `json:"threshold"` // °C, or signal severity 1..10
	Severity      string  `json:"severity"`  // info | warning | urgent
	Title         string  `json:"title"`
	Content       string  `json:"content"`
	CooldownHours int     `json:"cooldown_hours"` // min gap before re-firing
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
			"kpi-tiles", "room-utilisation", "usage-by-dept",
			"core-indicators", "activity-log",
		}
	}
	if len(c.SidebarModules) == 0 {
		c.SidebarModules = []string{
			"dashboard", "calendar", "search", "privilege",
			"reports", "admin", "my-bookings", "approvals",
		}
	}
	if len(c.WeekendDays) == 0 {
		c.WeekendDays = []int{6, 7} // Sat, Sun
	}
	// 0/0 means "never configured" → apply the FSD office-hours default.
	if c.CalendarStartHour == 0 && c.CalendarEndHour == 0 {
		c.CalendarStartHour = 8
		c.CalendarEndHour = 20
	}
	if c.CalendarStartHour < 0 || c.CalendarStartHour > 23 {
		c.CalendarStartHour = 8
	}
	if c.CalendarEndHour <= c.CalendarStartHour || c.CalendarEndHour > 23 {
		c.CalendarEndHour = 20
	}
	if len(c.ReportTypes) == 0 {
		c.ReportTypes = []string{"audit", "summary", "noshow", "staff", "usage", "medical", "addl"}
	}
	if len(c.RecurrencePatterns) == 0 {
		c.RecurrencePatterns = []string{"daily", "weekly", "monthly", "weekday"}
	}
	if c.BroadcastAutoRules == nil {
		c.BroadcastAutoRules = []BroadcastAutoRule{}
	}
	for i := range c.BroadcastAutoRules {
		if c.BroadcastAutoRules[i].CooldownHours <= 0 {
			c.BroadcastAutoRules[i].CooldownHours = 6
		}
		if c.BroadcastAutoRules[i].Severity == "" {
			c.BroadcastAutoRules[i].Severity = "warning"
		}
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
		CalendarStartHour:      8,
		CalendarEndHour:        20,
		ReportTypes:            []string{"audit", "summary", "noshow", "staff", "usage", "medical", "addl"},
		RecurrencePatterns:     []string{"daily", "weekly", "monthly", "weekday"},
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
