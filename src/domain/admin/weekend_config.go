package admin

import "time"

// ISO-8601 day-of-week numbering used by WeekendConfig.WeekendDays.
// 1=Monday, 2=Tuesday, ..., 6=Saturday, 7=Sunday.
const (
	DayMonday    = 1
	DayTuesday   = 2
	DayWednesday = 3
	DayThursday  = 4
	DayFriday    = 5
	DaySaturday  = 6
	DaySunday    = 7
)

// WeekendConfig represents a per-tenant configuration describing which days
// of the week are considered weekends for booking/holiday purposes.
//
// Per R16: Holiday Management - admins may define which days are weekends so
// that booking rules and holiday checks behave correctly in regions where the
// weekend differs from the default Saturday/Sunday.
//
// WeekendDays uses ISO-8601 day numbering where 1=Monday and 7=Sunday.
// The default is {6, 7} meaning Saturday and Sunday.
type WeekendConfig struct {
	ID          string    // Unique identifier (UUID)
	TenantID    string    // Tenant identifier (unique per tenant)
	WeekendDays []int     // ISO-8601 day numbers; default {6, 7} = Sat/Sun
	CreatedAt   time.Time // Record creation timestamp
}

// NewWeekendConfig creates a new WeekendConfig for the given tenant with the
// default weekend of Saturday and Sunday.
func NewWeekendConfig(tenantID string) *WeekendConfig {
	return &WeekendConfig{
		TenantID:    tenantID,
		WeekendDays: []int{DaySaturday, DaySunday},
		CreatedAt:   time.Now(),
	}
}

// IsWeekend reports whether the given time.Weekday is configured as a weekend
// day for this tenant. It converts Go's time.Weekday (where Sunday=0) to the
// ISO-8601 numbering (where Monday=1, Sunday=7) used by WeekendDays.
func (w *WeekendConfig) IsWeekend(day time.Weekday) bool {
	iso := weekdayToISO(day)
	for _, d := range w.WeekendDays {
		if d == iso {
			return true
		}
	}
	return false
}

// weekdayToISO converts Go's time.Weekday (Sunday=0..Saturday=6) to the
// ISO-8601 day-of-week numbering (Monday=1..Sunday=7).
func weekdayToISO(day time.Weekday) int {
	if day == time.Sunday {
		return DaySunday
	}
	return int(day)
}
