package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/tenant"
	"fsd-mrbs/src/domain/user"
)

// captureRepo records the criteria the handler builds so we can assert the
// all-day flag and tenant timezone are threaded through (QA #1, #2).
type captureRepo struct{ last booking.SearchCriteria }

func (c *captureRepo) FindAvailable(_ context.Context, cr booking.SearchCriteria, _ user.User) ([]booking.Resource, error) {
	c.last = cr
	return []booking.Resource{}, nil
}
func (c *captureRepo) GetByID(context.Context, string) (*booking.Resource, error) { return nil, nil }
func (c *captureRepo) Save(context.Context, booking.Resource) error               { return nil }
func (c *captureRepo) ListByTenant(context.Context, string) ([]booking.Resource, error) {
	return nil, nil
}
func (c *captureRepo) ListChildren(context.Context, string) ([]booking.Resource, error) {
	return nil, nil
}
func (c *captureRepo) Deactivate(context.Context, string) error { return nil }
func (c *captureRepo) GetOperatingHours(context.Context, string) ([]booking.OperatingHours, error) {
	return nil, nil
}
func (c *captureRepo) SetOperatingHours(context.Context, []booking.OperatingHours) error { return nil }

type fakeCustom struct{ tz string }

func (f fakeCustom) Get(context.Context, uuid.UUID) (*tenant.Customization, error) {
	return &tenant.Customization{Timezone: f.tz}, nil
}

func doSearch(t *testing.T, repo booking.ResourceRepository, custom CustomizationLookup, url string) {
	t.Helper()
	h := NewBookingHandler(repo, nil, custom)
	req := httptest.NewRequest(http.MethodGet, url, nil)
	// SearchAvailableRooms reads tenant id from context via tenantIDFromCtx,
	// which looks up the "tenant_id" context value.
	ctx := context.WithValue(req.Context(), "tenant_id", uuid.New().String())
	req = req.WithContext(ctx)
	h.SearchAvailableRooms(httptest.NewRecorder(), req)
}

// QA #2: an all_day=true search must set criteria.AllDay so the repo relaxes
// the operating-hours window instead of demanding 24h operation.
func TestSearch_AllDayFlagThreaded(t *testing.T) {
	repo := &captureRepo{}
	doSearch(t, repo, fakeCustom{tz: "Asia/Hong_Kong"},
		"/api/v1/bookings/search?date=2026-05-29&start_time=00:00&end_time=23:59&all_day=true&capacity=1")
	if !repo.last.AllDay {
		t.Error("expected criteria.AllDay = true for all_day=true search")
	}
}

func TestSearch_NotAllDayByDefault(t *testing.T) {
	repo := &captureRepo{}
	doSearch(t, repo, fakeCustom{tz: "Asia/Hong_Kong"},
		"/api/v1/bookings/search?date=2026-05-29&start_time=15:00&end_time=16:00&capacity=1")
	if repo.last.AllDay {
		t.Error("expected criteria.AllDay = false when all_day param absent")
	}
}

// QA #1: the tenant timezone must reach the repo so the wall-clock window is
// compared against true-UTC bookings in the right zone.
func TestSearch_TimezoneThreaded(t *testing.T) {
	repo := &captureRepo{}
	doSearch(t, repo, fakeCustom{tz: "Asia/Hong_Kong"},
		"/api/v1/bookings/search?date=2026-05-29&start_time=15:00&end_time=16:00&capacity=1")
	if repo.last.Timezone != "Asia/Hong_Kong" {
		t.Errorf("expected criteria.Timezone = Asia/Hong_Kong, got %q", repo.last.Timezone)
	}
}
