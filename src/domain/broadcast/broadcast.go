package broadcast

import (
	"context"
	"time"
)

// Broadcast represents a system-wide announcement or message.
// It supports multi-tenant isolation per R13 (Broadcast Messaging and Announcements).
type Broadcast struct {
	ID        string                 // Unique identifier (UUID)
	TenantID  string                 // Tenant identifier for multi-tenant isolation
	Title     string                 // Title of the broadcast
	Content   string                 // Content/body of the broadcast message
	ImageURL  string                 // Optional image URL for the broadcast
	StartDate time.Time              // Start date for broadcast visibility
	EndDate   time.Time              // End date for broadcast visibility
	Filters   map[string]interface{} // JSONB filters: {resources: [], locations: [], date_range: {}}
	CreatedBy string                 // User ID who created the broadcast
	CreatedAt time.Time              // Record creation timestamp
}

// Repository defines the contract for broadcast persistence
type Repository interface {
	// FindByID retrieves a broadcast by its ID
	FindByID(ctx context.Context, id string) (*Broadcast, error)

	// FindByTenant retrieves all broadcasts for a tenant
	FindByTenant(ctx context.Context, tenantID string) ([]Broadcast, error)

	// FindActive retrieves all active broadcasts for a tenant within the current time
	FindActive(ctx context.Context, tenantID string, now time.Time) ([]Broadcast, error)

	// FindByDateRange retrieves broadcasts that overlap with a given date range
	FindByDateRange(ctx context.Context, tenantID string, start, end time.Time) ([]Broadcast, error)

	// Save creates or updates a broadcast
	Save(ctx context.Context, b Broadcast) error

	// Delete removes a broadcast by ID
	Delete(ctx context.Context, id string) error
}

// IsActive returns true if the broadcast is currently active (within start and end dates)
func (b *Broadcast) IsActive(now time.Time) bool {
	return (now.Equal(b.StartDate) || now.After(b.StartDate)) &&
		(now.Equal(b.EndDate) || now.Before(b.EndDate))
}

// HasImage returns true if the broadcast has an image URL
func (b *Broadcast) HasImage() bool {
	return b.ImageURL != ""
}

// IsValid returns true if the broadcast has required fields populated
func (b *Broadcast) IsValid() bool {
	return b.Title != "" && b.Content != "" && !b.StartDate.IsZero() && !b.EndDate.IsZero()
}
