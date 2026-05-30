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
	bookings booking.Repository
	broker   MessageBroker
}

func NewUpdateBookingUseCase(b booking.Repository, m MessageBroker) *UpdateBookingUseCase {
	return &UpdateBookingUseCase{bookings: b, broker: m}
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
		// Re-run conflict detection scoped to the same resource. The repo
		// query treats the booking-being-updated as a conflict against
		// itself (same resource_id + active status), so we cancel it first
		// to free the slot, then re-save with new times. Cleaner approach
		// is a single SQL UPDATE that uses the EXCLUDE constraint to fail
		// loudly, which is what we do here:
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
