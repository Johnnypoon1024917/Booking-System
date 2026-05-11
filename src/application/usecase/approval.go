package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fsd-mrbs/src/domain/approval"
	"fsd-mrbs/src/domain/booking"

	"github.com/google/uuid"
)

// ApprovalUseCase orchestrates approve / reject decisions on bookings.
//
// Authorization is enforced at the handler layer (approver must be in the
// resource's approver_ids list, or have admin role). This use case assumes
// the caller has already verified that.
type ApprovalUseCase struct {
	bookings  booking.Repository
	resources booking.ResourceRepository
	approvals approval.Repository
	broker    MessageBroker
}

func NewApprovalUseCase(b booking.Repository, r booking.ResourceRepository, a approval.Repository, m MessageBroker) *ApprovalUseCase {
	return &ApprovalUseCase{bookings: b, resources: r, approvals: a, broker: m}
}

// Approve transitions a booking from Pending Approval → Confirmed and
// records an audit row. Idempotent: approving an already-Confirmed booking
// just records the audit entry without re-firing notifications.
func (uc *ApprovalUseCase) Approve(ctx context.Context, bookingID, approverID, reason string) error {
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}
	switch b.Status {
	case booking.StatusPendingApproval:
		if err := uc.bookings.UpdateStatus(ctx, bookingID, booking.StatusConfirmed, ""); err != nil {
			return err
		}
		uc.publishEvent("BOOKING_APPROVED", b)
	case booking.StatusConfirmed:
		// already approved — record the audit row anyway
	default:
		return errors.New("booking is not pending approval")
	}
	return uc.approvals.Save(ctx, approval.Approval{
		ID:         uuid.NewString(),
		TenantID:   b.TenantID,
		BookingID:  b.ID,
		ApproverID: approverID,
		Decision:   approval.DecisionApproved,
		Reason:     reason,
		DecidedAt:  time.Now(),
	})
}

// Reject sets the booking to Cancelled with the rejection reason and
// records an audit row.
func (uc *ApprovalUseCase) Reject(ctx context.Context, bookingID, approverID, reason string) error {
	if reason == "" {
		return errors.New("rejection reason is required")
	}
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}
	if b.Status != booking.StatusPendingApproval && b.Status != booking.StatusConfirmed {
		return errors.New("booking cannot be rejected from its current status")
	}
	if err := uc.bookings.UpdateStatus(ctx, bookingID, "Cancelled", "Rejected: "+reason); err != nil {
		return err
	}
	uc.publishEvent("BOOKING_REJECTED", b)
	return uc.approvals.Save(ctx, approval.Approval{
		ID:         uuid.NewString(),
		TenantID:   b.TenantID,
		BookingID:  b.ID,
		ApproverID: approverID,
		Decision:   approval.DecisionRejected,
		Reason:     reason,
		DecidedAt:  time.Now(),
	})
}

func (uc *ApprovalUseCase) publishEvent(name string, b booking.Booking) {
	if uc.broker == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"event":       name,
		"tenant_id":   b.TenantID,
		"booking_id":  b.ID,
		"resource_id": b.ResourceID,
		"user_id":     b.UserID,
		"start_time":  b.StartTime.Format(time.RFC3339),
		"end_time":    b.EndTime.Format(time.RFC3339),
		"status":      b.Status,
	})
	_ = uc.broker.Publish("booking_events", payload)
}
