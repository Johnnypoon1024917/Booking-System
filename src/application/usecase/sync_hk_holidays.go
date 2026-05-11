package usecase

import (
	"context"
	"time"

	"fsd-mrbs/src/domain/holiday"
	"fsd-mrbs/src/infrastructure/external"

	"github.com/google/uuid"
)

// SyncHKHolidaysUseCase imports public holidays from the gov.hk feed.
//
// Designed to run nightly via a scheduler. It is idempotent: existing
// holidays for a given date are left alone; new ones are added with
// IsBlocker=true.
type SyncHKHolidaysUseCase struct {
	client      *external.GovHKHolidayClient
	holidayRepo holiday.Repository
}

func NewSyncHKHolidaysUseCase(client *external.GovHKHolidayClient, repo holiday.Repository) *SyncHKHolidaysUseCase {
	return &SyncHKHolidaysUseCase{client: client, holidayRepo: repo}
}

// SyncResult is what the handler returns to the admin.
type SyncResult struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Errors   []string `json:"errors,omitempty"`
}

// Execute pulls the current feed and writes new holidays for the given
// tenant. Locale controls which language feed to use for descriptions.
func (uc *SyncHKHolidaysUseCase) Execute(ctx context.Context, tenantID uuid.UUID, locale string, createdBy string) (SyncResult, error) {
	res := SyncResult{}
	feed, err := uc.client.Fetch(ctx, locale)
	if err != nil {
		return res, err
	}
	tenantStr := tenantID.String()
	for _, h := range feed {
		existing, err := uc.holidayRepo.FindByTenantAndDate(ctx, tenantStr, h.Date)
		if err == nil && existing != nil {
			res.Skipped++
			continue
		}
		entry := holiday.Holiday{
			ID:          uuid.NewString(),
			TenantID:    tenantStr,
			HolidayDate: h.Date,
			Description: h.Description,
			IsBlocker:   true,
			CreatedBy:   createdBy,
			CreatedAt:   time.Now(),
		}
		if err := uc.holidayRepo.Save(ctx, entry); err != nil {
			res.Errors = append(res.Errors, h.Date.Format("2006-01-02")+": "+err.Error())
			continue
		}
		res.Imported++
	}
	return res, nil
}
