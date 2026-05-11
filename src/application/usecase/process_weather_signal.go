package usecase

import (
	"context"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/infrastructure/external"
)

// ProcessWeatherSignalUseCase is the bridge between the HKO feed and the
// booking exception workflow. When a T8+ or Black Rainstorm warning is
// active, it iterates same-day No-Show or Confirmed bookings and marks
// them as Exception with a reason like "Auto: HKO Typhoon T8". This is
// what powers the "All No-Show penalties currently suspended" banner.
type ProcessWeatherSignalUseCase struct {
	hko      *external.HKOClient
	bookings booking.Repository
}

func NewProcessWeatherSignalUseCase(hko *external.HKOClient, b booking.Repository) *ProcessWeatherSignalUseCase {
	return &ProcessWeatherSignalUseCase{hko: hko, bookings: b}
}

// WeatherProcessResult tells the caller what changed.
type WeatherProcessResult struct {
	ActiveSignals []external.WeatherSignal
	MarkedCount   int
}

// Execute checks the current HKO signals and applies exception status to
// bookings that fall inside the active-from / now window. Idempotent: a
// booking already in StatusException is skipped.
func (uc *ProcessWeatherSignalUseCase) Execute(ctx context.Context, sameDayBookings []booking.Booking) (WeatherProcessResult, error) {
	res := WeatherProcessResult{}
	signals, err := uc.hko.CurrentSignals(ctx)
	if err != nil {
		return res, err
	}
	res.ActiveSignals = signals

	suspending := ""
	for _, s := range signals {
		if s.SuspendsBookings() {
			suspending = s.Code
			break
		}
	}
	if suspending == "" {
		return res, nil
	}

	reason := fmt.Sprintf("Auto: HKO %s active at %s", suspending, time.Now().Format("2006-01-02 15:04"))
	for _, b := range sameDayBookings {
		if b.Status == booking.StatusException || b.Status == booking.StatusCheckedIn {
			continue
		}
		b.Status = booking.StatusException
		b.ExceptionNotes = reason
		if err := uc.bookings.Save(ctx, b); err == nil {
			res.MarkedCount++
		}
	}
	return res, nil
}
