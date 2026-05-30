package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fsd-mrbs/src/domain/booking"
)

// UpdateBookingUseCase mutates the time window or meeting URL of an
// existing booking. Only the owner or an admin can call it. The handler
// is responsible for that authorization check.
//
// Conflict detection is re-run because the new window may collide with
// other bookings on the same (or composite) resource.
type UpdateBookingUseCase struct {
	bookings  booking.Repository
	broker    MessageBroker
	validator *BookingValidator
}

func NewUpdateBookingUseCase(b booking.Repository, m MessageBroker) *UpdateBookingUseCase {
	return &UpdateBookingUseCase{bookings: b, broker: m}
}

// WithValidator attaches the shared booking validator. When set, a time
// change is re-validated against the same holiday / shared-capacity /
// privilege rules enforced at creation, closing the bypass where a reschedule
// skipped every business check (audit #1). Left nil (older callers / tests)
// the update behaves as before and relies on the DB EXCLUDE constraint alone.
func (uc *UpdateBookingUseCase) WithValidator(v *BookingValidator) *UpdateBookingUseCase {
	uc.validator = v
	return uc
}

type UpdateRequest struct {
	BookingID  string
	NewStart   time.Time
	NewEnd     time.Time
	MeetingURL *string // pointer so we can distinguish "unset" from "clear"
	Title      *string // pointer so we can distinguish "unset" from "clear" (QA #6)
}

func (uc *UpdateBookingUseCase) Execute(ctx context.Context, req UpdateRequest) (booking.Booking, error) {
	b, err := uc.bookings.FindByID(ctx, req.BookingID)
	if err != nil {
		return booking.Booking{}, err
	}
	if b.Status == booking.StatusCancelled || b.Status == booking.StatusNoShow {
		return booking.Booking{}, errors.New("cannot update a cancelled or expired booking")
	}

	timeChanged := !req.NewStart.IsZero() && !req.NewEnd.IsZero() &&
		(!req.NewStart.Equal(b.StartTime) || !req.NewEnd.Equal(b.EndTime))

	if timeChanged {
		if !req.NewEnd.After(req.NewStart) {
			return booking.Booking{}, errors.New("end must be after start")
		}
		// Re-validate the new window against the same business rules a
		// creation would face: holiday blocking, shared-capacity limits
		// (race-safe via FOR UPDATE) and the org-hierarchy privilege matrix.
		// Before this the update path skipped all of them (audit #1). The
		// booking being moved is excluded from its own capacity tally; for
		// exclusive resources the bookings_no_overlap EXCLUDE constraint at
		// Save time remains the authoritative overlap check.
		if uc.validator != nil {
			vres, verr := uc.validator.Validate(ctx, ValidationInput{
				TenantID:         b.TenantID,
				UserID:           b.UserID,
				ResourceID:       b.ResourceID,
				Start:            req.NewStart,
				End:              req.NewEnd,
				ExcludeBookingID: b.ID,
			})
			if verr != nil {
				return booking.Booking{}, verr
			}
			// If policy now requires approval for the new window, drop the
			// booking back to Pending so a privileged slot can't be claimed
			// as Confirmed via an update (audit #1 privilege bypass).
			if vres.RequiresApproval && b.Status == booking.StatusConfirmed {
				b.Status = booking.StatusPendingApproval
			}
		}
		b.StartTime = req.NewStart
		b.EndTime = req.NewEnd
	}

	if req.MeetingURL != nil {
		b.MeetingURL = *req.MeetingURL
	}

	if req.Title != nil {
		b.Title = *req.Title
	}

	if err := uc.bookings.Save(ctx, b); err != nil {
		return booking.Booking{}, err
	}
	uc.publish("BOOKING_UPDATED", b)
	return b, nil
}

// Cancel marks a booking cancelled. Only the owner or an admin should
// reach this code path; the handler enforces that.
func (uc *UpdateBookingUseCase) Cancel(ctx context.Context, bookingID, reason string) error {
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}
	if b.Status == booking.StatusCancelled {
		return nil // idempotent
	}
	if err := uc.bookings.Cancel(ctx, bookingID, reason); err != nil {
		return err
	}
	b.Status = booking.StatusCancelled
	uc.publish("BOOKING_CANCELLED", b)
	return nil
}

func (uc *UpdateBookingUseCase) publish(event string, b booking.Booking) {
	if uc.broker == nil {
		return
	}
	payload, _ := json.Marshal(map[string]any{
		"event":       event,
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
