// Package approval models the audit trail of approve/reject decisions on
// bookings. The booking itself transitions in the booking package; this
// package records who decided what and why so we have a permanent log
// even after the booking has moved on or been cancelled.
package approval

import (
	"context"
	"time"
)

const (
	DecisionApproved = "approved"
	DecisionRejected = "rejected"
)

// Approval is one row in the audit trail.
type Approval struct {
	ID         string
	TenantID   string
	BookingID  string
	ApproverID string // empty when an approval is automated by the system
	Decision   string // DecisionApproved | DecisionRejected
	Reason     string
	DecidedAt  time.Time
}

// Repository persists approval audit rows.
type Repository interface {
	Save(ctx context.Context, a Approval) error
	ListByBooking(ctx context.Context, bookingID string) ([]Approval, error)
	ListByTenant(ctx context.Context, tenantID string, limit int) ([]Approval, error)
}
