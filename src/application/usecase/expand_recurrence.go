package usecase

import (
	"context"
	"errors"
	"time"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/rrule"

	"github.com/google/uuid"
)

// ExpandRecurringBookingRequest describes a recurring booking the user
// wants to create. The use case generates one booking row per occurrence
// (capped at 100, per the existing recurring_series table comment) and
// inserts them all under a shared recurrence_id so cancelling the series
// is a single UPDATE.
type ExpandRecurringBookingRequest struct {
	TenantID   string
	ResourceID string
	UserID     string
	Pattern    string // booking.PatternDaily / Weekly / BiWeekly / Monthly
	FirstStart time.Time
	FirstEnd   time.Time
	Count      int   // total occurrences (1 .. 100)
	DayOfWeek  []int // for weekly: 0=Sun..6=Sat. Empty = use FirstStart's weekday.
	DayOfMonth int   // for monthly: 1..31. Zero = use FirstStart's day.
	MeetingURL string

	// RRule is an optional RFC 5545 recurrence rule. When set it takes
	// precedence over Pattern/Count/DayOfWeek/DayOfMonth — those legacy
	// fields exist only so older SPA builds keep working. New clients
	// (Outlook add-in, mobile, public API) should always send RRule.
	RRule    string
	ExDates  []time.Time
}

// ExpandRecurringBooking inserts the entire series. If any occurrence
// conflicts, the whole transaction is rolled back so we don't leave a
// half-booked series. Returns the recurrence id and the list of created
// booking ids.
type ExpandRecurringBookingUseCase struct {
	bookings booking.Repository
	series   booking.RecurringSeriesRepository
}

func NewExpandRecurringBookingUseCase(b booking.Repository, s booking.RecurringSeriesRepository) *ExpandRecurringBookingUseCase {
	return &ExpandRecurringBookingUseCase{bookings: b, series: s}
}

type ExpansionResult struct {
	RecurrenceID string
	BookingIDs   []string
	Skipped      []string // ISO timestamps of occurrences skipped due to conflict
}

func (uc *ExpandRecurringBookingUseCase) Execute(ctx context.Context, req ExpandRecurringBookingRequest) (ExpansionResult, error) {
	if !req.FirstEnd.After(req.FirstStart) {
		return ExpansionResult{}, errors.New("end must be after start")
	}

	var occurrences []occurrence
	if req.RRule != "" {
		// RFC 5545 path: parse the rule, attach EXDATEs, expand, and
		// convert to the local occurrence type the rest of this use
		// case already handles.
		rule, err := rrule.Parse(req.RRule)
		if err != nil {
			return ExpansionResult{}, err
		}
		rule.ExDates = req.ExDates
		expanded, err := rule.Expand(req.FirstStart, req.FirstEnd)
		if err != nil {
			return ExpansionResult{}, err
		}
		if len(expanded) == 0 {
			return ExpansionResult{}, errors.New("rrule produced no occurrences")
		}
		for _, o := range expanded {
			occurrences = append(occurrences, occurrence{start: o.Start, end: o.End})
		}
	} else {
		if req.Count < 1 || req.Count > 100 {
			return ExpansionResult{}, errors.New("count must be between 1 and 100")
		}
		occurrences = generateOccurrences(req)
	}

	seriesID := uuid.NewString()
	if err := uc.series.Save(ctx, booking.RecurringSeries{
		ID:         seriesID,
		TenantID:   req.TenantID,
		ResourceID: req.ResourceID,
		UserID:     req.UserID,
		Pattern:    req.Pattern,
		StartDate:  req.FirstStart,
		EndDate:    occurrences[len(occurrences)-1].end,
		TimeStart:  req.FirstStart,
		TimeEnd:    req.FirstEnd,
		DayOfWeek:  req.DayOfWeek,
		DayOfMonth: req.DayOfMonth,
		Status:     booking.SeriesStatusActive,
		CreatedAt:  time.Now(),
	}); err != nil {
		return ExpansionResult{}, err
	}

	res := ExpansionResult{RecurrenceID: seriesID}
	for _, occ := range occurrences {
		// Per-occurrence conflict check before INSERT. Best-effort: the
		// EXCLUDE constraint at the DB level is still the final word.
		conflict, _ := uc.bookings.HasConflict(ctx, req.ResourceID, occ.start, occ.end)
		if conflict {
			res.Skipped = append(res.Skipped, occ.start.Format(time.RFC3339))
			continue
		}
		b := booking.Booking{
			ID:           uuid.NewString(),
			TenantID:     req.TenantID,
			ResourceID:   req.ResourceID,
			UserID:       req.UserID,
			StartTime:    occ.start,
			EndTime:      occ.end,
			Status:       booking.StatusConfirmed,
			IsRecurring:  true,
			RecurrenceID: seriesID,
			MeetingURL:   req.MeetingURL,
			Version:      1,
			CreatedAt:    time.Now(),
		}
		if err := uc.bookings.Save(ctx, b); err != nil {
			res.Skipped = append(res.Skipped, occ.start.Format(time.RFC3339))
			continue
		}
		res.BookingIDs = append(res.BookingIDs, b.ID)
	}
	return res, nil
}

type occurrence struct{ start, end time.Time }

// generateOccurrences expands a pattern into concrete (start, end) pairs.
// Keep the logic here — it's the part most likely to need tweaks per
// tenant (e.g. skip weekends, skip holidays). Hooks for those can be
// added without touching the repos.
func generateOccurrences(req ExpandRecurringBookingRequest) []occurrence {
	out := make([]occurrence, 0, req.Count)
	out = append(out, occurrence{start: req.FirstStart, end: req.FirstEnd})

	for i := 1; i < req.Count; i++ {
		prev := out[i-1]
		var next occurrence
		switch req.Pattern {
		case booking.PatternDaily:
			next = occurrence{start: prev.start.AddDate(0, 0, 1), end: prev.end.AddDate(0, 0, 1)}
		case booking.PatternWeekly:
			next = occurrence{start: prev.start.AddDate(0, 0, 7), end: prev.end.AddDate(0, 0, 7)}
		case booking.PatternBiWeekly:
			next = occurrence{start: prev.start.AddDate(0, 0, 14), end: prev.end.AddDate(0, 0, 14)}
		case booking.PatternMonthly:
			next = occurrence{start: prev.start.AddDate(0, 1, 0), end: prev.end.AddDate(0, 1, 0)}
		default:
			return out // unknown pattern: don't expand further
		}
		out = append(out, next)
	}
	return out
}
