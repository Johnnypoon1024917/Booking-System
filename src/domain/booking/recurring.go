package booking

import (
	"context"
	"time"
)

// Recurrence pattern types
const (
	PatternDaily    = "daily"
	PatternWeekly   = "weekly"
	PatternBiWeekly = "bi-weekly"
	PatternMonthly  = "monthly"
)

// Recurring series status types
const (
	SeriesStatusActive    = "Active"
	SeriesStatusCancelled = "Cancelled"
	SeriesStatusCompleted = "Completed"
)

// RecurringSeries represents a recurring booking series configuration.
// It defines the pattern and parameters for generating multiple bookings.
type RecurringSeries struct {
	ID          string    // Unique identifier (UUID)
	TenantID    string    // Tenant identifier for multi-tenant isolation
	ResourceID  string    // ID of the resource being booked
	UserID      string    // ID of the user who created the series
	Pattern     string    // Recurrence pattern: 'daily', 'weekly', 'bi-weekly', 'monthly'
	StartDate   time.Time // Start date of the recurring series
	EndDate     time.Time // End date of the recurring series (calculated from max 100 occurrences)
	TimeStart   time.Time // Start time for each occurrence (time component only)
	TimeEnd     time.Time // End time for each occurrence (time component only)
	DayOfWeek   []int     // Days of week for weekly patterns: [0,1,2,3,4,5,6] where 0=Sunday
	DayOfMonth  int       // Day of month for monthly patterns: 1-31
	Status      string    // Current status: Active, Cancelled, Completed
	CreatedAt   time.Time // Record creation timestamp
}

// RecurringSeriesRepository defines the contract for recurring series persistence
type RecurringSeriesRepository interface {
	GetByID(ctx context.Context, id string) (*RecurringSeries, error)
	Save(ctx context.Context, series RecurringSeries) error
	ListByUser(ctx context.Context, userID string) ([]RecurringSeries, error)
	UpdateStatus(ctx context.Context, id, status string) error
	ListByResource(ctx context.Context, resourceID string) ([]RecurringSeries, error)
}
