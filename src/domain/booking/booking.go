package booking

import (
	"context"
	"errors"
	"time"
)

var ErrConcurrencyConflict = errors.New("optimistic locking conflict: record was modified by another process")

const (
	StatusPendingApproval = "Pending Approval"
	StatusConfirmed       = "Confirmed"
	StatusCheckedIn       = "Checked In"
	StatusNoShow          = "No Show"
	StatusException       = "Exception"
)

// Booking represents a resource booking in the system.
// It supports multi-tenant isolation, recurring bookings, and meeting URL masking.
type Booking struct {
	ID             string     // Unique identifier (UUID)
	TenantID       string     // Tenant identifier for multi-tenant isolation
	ResourceID     string     // ID of the booked resource
	UserID         string     // ID of the user who made the booking
	StartTime      time.Time  // Booking start time
	EndTime        time.Time  // Booking end time
	Status         string     // Current status: Confirmed, Pending Approval, Checked In, No Show, Exception, Cancelled
	IsRecurring    bool       // Whether this booking is part of a recurring series
	RecurrenceID   string     // Reference to the recurring series (if IsRecurring is true)
	ExceptionNotes string     // Notes for exceptions in recurring bookings
	MeetingURL     string     // Original Zoom/Teams URL (R14 - Online Meeting URL Masking)
	RedirectURL    string     // Masked static URL (R14 - Online Meeting URL Masking)
	CheckedInAt    *time.Time // Timestamp when user checked in (R9 - Check-In and Status Tracking), nil if not checked in
	Version        int        // Optimistic locking version
	CreatedAt      time.Time  // Record creation timestamp

	// BookingMode is denormalized from the resource at insert time so the
	// bookings_no_overlap EXCLUDE constraint can ignore shared-mode rows
	// without joining back to resources. "exclusive" by default.
	BookingMode string
}

// Repository defines the contract for booking persistence
type Repository interface {
	HasConflict(ctx context.Context, resourceID string, start, end time.Time) (bool, error)
	HasConflictTenant(ctx context.Context, tenantID, resourceID string, start, end time.Time) (bool, error)
	Save(ctx context.Context, b Booking) error
	UpdateStatus(ctx context.Context, id, status, notes string) error
	Cancel(ctx context.Context, id, reason string) error
	FindByID(ctx context.Context, id string) (Booking, error)
	ListByUser(ctx context.Context, userID string) ([]Booking, error)
	ListByUserUpcoming(ctx context.Context, userID string) ([]Booking, error)
	ListByResource(ctx context.Context, resourceID string) ([]Booking, error)
	ListPendingForApprover(ctx context.Context, tenantID, approverID string) ([]Booking, error)
	CountActiveByUser(ctx context.Context, userID string) (int, error)
	// CountConcurrent returns the number of active bookings whose time
	// range overlaps [start, end) on the given resource. Used to enforce
	// shared_capacity for shared-mode resources (e.g. gym = 10 concurrent).
	CountConcurrent(ctx context.Context, resourceID string, start, end time.Time) (int, error)
}
