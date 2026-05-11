package meeting

import (
	"context"
	"time"
)

// MeetingRedirect represents a masked URL mapping for online meetings.
// It provides a static, tenant-branded URL that redirects to the actual meeting platform.
// Per R14: Online Meeting URL Masking - provides privacy and consistent user experience.
type MeetingRedirect struct {
	ID          string    // Unique identifier (UUID)
	TenantID    string    // Tenant identifier for multi-tenant isolation
	BookingID   string    // Reference to the associated booking
	StaticURL   string    // The masked URL (e.g., /meet/abc123)
	OriginalURL string    // The actual Zoom/Teams URL
	CreatedAt   time.Time // Record creation timestamp
}

// Repository defines the contract for meeting redirect persistence
type Repository interface {
	GetByStaticURL(ctx context.Context, staticURL string) (*MeetingRedirect, error)
	GetByBookingID(ctx context.Context, bookingID string) (*MeetingRedirect, error)
	Save(ctx context.Context, redirect MeetingRedirect) error
	UpdateOriginalURL(ctx context.Context, id, originalURL string) error
	Delete(ctx context.Context, id string) error
}
