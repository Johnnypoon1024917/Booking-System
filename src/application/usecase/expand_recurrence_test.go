package usecase

import (
	"context"
	"testing"
	"time"

	"fsd-mrbs/src/domain/booking"
)

// --- in-memory fakes -------------------------------------------------------

type fakeBookingRepo struct {
	saved     []booking.Booking
	conflicts map[string]bool // keyed by RFC3339 start time
}

func (f *fakeBookingRepo) Save(_ context.Context, b booking.Booking) error {
	f.saved = append(f.saved, b)
	return nil
}
func (f *fakeBookingRepo) FindByID(context.Context, string) (booking.Booking, error) {
	return booking.Booking{}, nil
}
func (f *fakeBookingRepo) UpdateStatus(context.Context, string, string, string) error { return nil }
func (f *fakeBookingRepo) HasConflict(_ context.Context, _ string, start, _ time.Time) (bool, error) {
	return f.conflicts[start.Format(time.RFC3339)], nil
}
func (f *fakeBookingRepo) CountConcurrent(context.Context, string, time.Time, time.Time) (int, error) {
	return 0, nil
}
func (f *fakeBookingRepo) AddServiceToBooking(context.Context, string, string, int, string) error {
	return nil
}
func (f *fakeBookingRepo) Cancel(context.Context, string, string) error { return nil }

type fakeSeriesRepo struct{ saved []booking.RecurringSeries }

func (f *fakeSeriesRepo) GetByID(context.Context, string) (*booking.RecurringSeries, error) {
	return nil, nil
}
func (f *fakeSeriesRepo) Save(_ context.Context, s booking.RecurringSeries) error {
	f.saved = append(f.saved, s)
	return nil
}
func (f *fakeSeriesRepo) ListByUser(context.Context, string) ([]booking.RecurringSeries, error) {
	return nil, nil
}
func (f *fakeSeriesRepo) UpdateStatus(context.Context, string, string) error { return nil }
func (f *fakeSeriesRepo) ListByResource(context.Context, string) ([]booking.RecurringSeries, error) {
	return nil, nil
}

// --- tests -----------------------------------------------------------------

// QA #4: a daily recurrence with count N must materialise N bookings under a
// shared recurrence id. Before the fix the expansion use case was constructed
// and discarded, so submitting "recurring" silently created nothing.
func TestExpandRecurring_DailyCreatesNOccurrences(t *testing.T) {
	br := &fakeBookingRepo{}
	sr := &fakeSeriesRepo{}
	uc := NewExpandRecurringBookingUseCase(br, sr)

	start := time.Date(2026, 5, 29, 15, 0, 0, 0, time.UTC)
	res, err := uc.Execute(context.Background(), ExpandRecurringBookingRequest{
		TenantID:   "t1",
		ResourceID: "r1",
		UserID:     "u1",
		Pattern:    booking.PatternDaily,
		FirstStart: start,
		FirstEnd:   start.Add(time.Hour),
		Count:      10,
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if len(res.BookingIDs) != 10 {
		t.Fatalf("expected 10 bookings, got %d", len(res.BookingIDs))
	}
	if len(br.saved) != 10 {
		t.Fatalf("expected 10 saved rows, got %d", len(br.saved))
	}
	if len(sr.saved) != 1 {
		t.Fatalf("expected 1 series row, got %d", len(sr.saved))
	}
	// Each occurrence must be exactly one day after the previous, tagged with
	// the same recurrence id and flagged recurring.
	for i, b := range br.saved {
		want := start.AddDate(0, 0, i)
		if !b.StartTime.Equal(want) {
			t.Errorf("occurrence %d: start = %v, want %v", i, b.StartTime, want)
		}
		if b.RecurrenceID != res.RecurrenceID {
			t.Errorf("occurrence %d: recurrence id = %q, want %q", i, b.RecurrenceID, res.RecurrenceID)
		}
		if !b.IsRecurring {
			t.Errorf("occurrence %d: IsRecurring = false, want true", i)
		}
	}
}

// A clashing occurrence is skipped (reported in Skipped) rather than aborting
// the whole series.
func TestExpandRecurring_SkipsConflicts(t *testing.T) {
	start := time.Date(2026, 5, 29, 15, 0, 0, 0, time.UTC)
	clash := start.AddDate(0, 0, 2) // the 3rd occurrence conflicts
	br := &fakeBookingRepo{conflicts: map[string]bool{clash.Format(time.RFC3339): true}}
	sr := &fakeSeriesRepo{}
	uc := NewExpandRecurringBookingUseCase(br, sr)

	res, err := uc.Execute(context.Background(), ExpandRecurringBookingRequest{
		TenantID: "t1", ResourceID: "r1", UserID: "u1",
		Pattern: booking.PatternDaily, FirstStart: start, FirstEnd: start.Add(time.Hour), Count: 5,
	})
	if err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if len(res.BookingIDs) != 4 {
		t.Errorf("expected 4 created, got %d", len(res.BookingIDs))
	}
	if len(res.Skipped) != 1 {
		t.Errorf("expected 1 skipped, got %d", len(res.Skipped))
	}
}

// Weekly recurrence steps 7 days between occurrences.
func TestExpandRecurring_WeeklyStep(t *testing.T) {
	start := time.Date(2026, 5, 29, 9, 0, 0, 0, time.UTC)
	br := &fakeBookingRepo{}
	uc := NewExpandRecurringBookingUseCase(br, &fakeSeriesRepo{})
	if _, err := uc.Execute(context.Background(), ExpandRecurringBookingRequest{
		TenantID: "t1", ResourceID: "r1", UserID: "u1",
		Pattern: booking.PatternWeekly, FirstStart: start, FirstEnd: start.Add(time.Hour), Count: 3,
	}); err != nil {
		t.Fatalf("Execute returned error: %v", err)
	}
	if len(br.saved) != 3 {
		t.Fatalf("expected 3, got %d", len(br.saved))
	}
	if got, want := br.saved[1].StartTime, start.AddDate(0, 0, 7); !got.Equal(want) {
		t.Errorf("2nd occurrence = %v, want %v", got, want)
	}
}

// count must be within 1..100.
func TestExpandRecurring_RejectsBadCount(t *testing.T) {
	uc := NewExpandRecurringBookingUseCase(&fakeBookingRepo{}, &fakeSeriesRepo{})
	start := time.Date(2026, 5, 29, 9, 0, 0, 0, time.UTC)
	if _, err := uc.Execute(context.Background(), ExpandRecurringBookingRequest{
		TenantID: "t1", ResourceID: "r1", UserID: "u1",
		Pattern: booking.PatternDaily, FirstStart: start, FirstEnd: start.Add(time.Hour), Count: 0,
	}); err == nil {
		t.Error("expected error for count=0, got nil")
	}
}
