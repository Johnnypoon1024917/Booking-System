package usecase

import (
	"context"
	"time"

	"fsd-mrbs/src/domain/booking"
)

// PendingBookingsLister returns bookings that started before "now - grace"
// and are still in Confirmed status (i.e., users never checked in). The
// scheduler invokes it every minute.
type PendingBookingsLister interface {
	ListUncheckedConfirmed(ctx context.Context, before time.Time) ([]booking.Booking, error)
}

// AutoReleaseUseCase converts uncheckedin Confirmed bookings to No Show
// after the configured grace period. The freed slot becomes available for
// new bookings on the very next conflict check.
type AutoReleaseUseCase struct {
	repo  PendingBookingsLister
	saver booking.Repository
}

func NewAutoReleaseUseCase(lister PendingBookingsLister, saver booking.Repository) *AutoReleaseUseCase {
	return &AutoReleaseUseCase{repo: lister, saver: saver}
}

// AutoReleaseResult counts bookings flipped on this tick, for observability.
type AutoReleaseResult struct {
	Released int
	At       time.Time
}

// Tick processes one round of auto-release. Run it every minute from the
// scheduler binary.
func (uc *AutoReleaseUseCase) Tick(ctx context.Context, gracePeriod time.Duration) (AutoReleaseResult, error) {
	cutoff := time.Now().Add(-gracePeriod)
	candidates, err := uc.repo.ListUncheckedConfirmed(ctx, cutoff)
	if err != nil {
		return AutoReleaseResult{}, err
	}
	released := 0
	for _, b := range candidates {
		if b.Status != booking.StatusConfirmed || b.CheckedInAt != nil {
			continue
		}
		b.Status = booking.StatusNoShow
		if err := uc.saver.Save(ctx, b); err == nil {
			released++
		}
	}
	return AutoReleaseResult{Released: released, At: time.Now()}, nil
}
