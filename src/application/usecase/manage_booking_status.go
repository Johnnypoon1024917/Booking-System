package usecase

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/booking"
	"time"
)

type ManageBookingStatusUseCase struct {
	repo booking.Repository
}

func NewManageBookingStatusUseCase(r booking.Repository) *ManageBookingStatusUseCase {
	return &ManageBookingStatusUseCase{repo: r}
}

// MarkAsException handles the Typhoon/No-Show Customisation
func (uc *ManageBookingStatusUseCase) MarkAsException(ctx context.Context, bookingID string, adminID string, reason string) error {
	// 1. Fetch existing booking (Mocked repository fetch for brevity)
	b, err := uc.repo.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}

	// 2. Validate current state: Only No-Shows or Confirmed bookings can be marked as exceptions
	if b.Status == booking.StatusCheckedIn {
		return errors.New("cannot mark a checked-in booking as an exception")
	}

	// 3. Apply Exception Logic
	b.Status = booking.StatusException
	b.ExceptionNotes = reason // e.g., "Typhoon Signal No. 8"

	// 4. Persist changes with Optimistic Locking
	return uc.repo.Save(ctx, b)
}

// UpdateCheckInStatus handles standard check-ins and no-shows
func (uc *ManageBookingStatusUseCase) UpdateCheckInStatus(ctx context.Context, bookingID string, isCheckIn bool) error {
	b, err := uc.repo.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}

	if isCheckIn {
		b.Status = booking.StatusCheckedIn
		now := time.Now()
		b.CheckedInAt = &now
	} else {
		b.Status = booking.StatusNoShow
	}

	return uc.repo.Save(ctx, b)
}
