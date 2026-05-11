package holiday

import (
	"context"
	"time"
)

// Holiday represents a holiday date that may block bookings.
// It supports multi-tenant isolation per R16 (Holiday Management).
type Holiday struct {
	ID          string    // Unique identifier (UUID)
	TenantID    string    // Tenant identifier for multi-tenant isolation
	HolidayDate time.Time // The date of the holiday
	Description string    // Description of the holiday
	IsBlocker   bool      // Whether this holiday blocks bookings
	CreatedBy   string    // User ID who created the holiday
	CreatedAt   time.Time // Record creation timestamp
}

// Repository defines the contract for holiday persistence
type Repository interface {
	// FindByTenantAndDate retrieves a holiday for a specific tenant on a given date
	FindByTenantAndDate(ctx context.Context, tenantID string, date time.Time) (*Holiday, error)

	// FindByTenantAndDateRange retrieves all holidays for a tenant within a date range
	FindByTenantAndDateRange(ctx context.Context, tenantID string, start, end time.Time) ([]Holiday, error)

	// FindAllByTenant retrieves all holidays for a tenant
	FindAllByTenant(ctx context.Context, tenantID string) ([]Holiday, error)

	// Save creates or updates a holiday
	Save(ctx context.Context, h Holiday) error

	// Delete removes a holiday by ID
	Delete(ctx context.Context, id string) error
}

// IsBlocking returns true if this holiday blocks bookings
func (h *Holiday) IsBlocking() bool {
	return h.IsBlocker
}

// IsValidDate returns true if the holiday date is valid (not zero)
func (h *Holiday) IsValidDate() bool {
	return !h.HolidayDate.IsZero()
}
