package booking

import (
	"context"
	"errors"
	"time"
)

var (
	ErrConcurrencyConflict = errors.New("concurrency conflict: booking already exists or was updated by another transaction")
)

const (
	StatusPendingApproval = "Pending Approval"
	StatusConfirmed       = "Confirmed"
	StatusCancelled       = "Cancelled"
	StatusCheckedIn       = "Checked In"
	StatusNoShow          = "No Show"
	StatusException       = "Exception"
)

// Repository defines the persistence interface for bookings.
type Repository interface {
	Save(ctx context.Context, b Booking) error
	FindByID(ctx context.Context, id string) (Booking, error)
	UpdateStatus(ctx context.Context, id, status, notes string) error
	HasConflict(ctx context.Context, resourceID string, start, end time.Time) (bool, error)
	CountConcurrent(ctx context.Context, resourceID string, start, end time.Time) (int, error)
	AddServiceToBooking(ctx context.Context, bookingID, serviceID string, quantity int, notes string) error
	Cancel(ctx context.Context, id, reason string) error
}

// Booking represents a single reservation of a resource.
type Booking struct {
	ID         string
	TenantID   string
	ResourceID string
	// ResourceName is a denormalised, non-PII copy of the resource's
	// display name, populated at the response edge by ProjectBooking.
	// The SPA's My Bookings / admin views render this directly so a
	// caller who cannot list every resource (e.g. an officer) never sees
	// a raw resource UUID as the booking heading.
	ResourceName       string
	UserID             string
	StartTime, EndTime time.Time
	Status             string
	IsRecurring        bool
	RecurrenceID       string
	ExceptionNotes     string
	MeetingURL         string
	RedirectURL        string
	CheckedInAt        *time.Time
	Version            int
	CreatedAt          time.Time
	BookingMode        string
	// Title is the meeting subject the organiser typed in the SPA's
	// BookingModal — e.g. "Daily Standup". Optional; when empty the
	// calendar falls back to a generic label so legacy rows still read.
	Title string
	// IsPrivate is the Outlook-style "Private appointment" flag. When
	// true, only the owner and System Admin see PII (title, organiser,
	// meeting URL); everyone else gets "Reserved" via ProjectBooking,
	// even if the resource's details ACL would otherwise grant them
	// access. See domain/booking/visibility.go for the policy.
	IsPrivate bool
}
