package usecase

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/admin"
	"time"
)

type AdminManagerUseCase struct {
	repo admin.AdminRepository
}

func NewAdminManagerUseCase(repo admin.AdminRepository) *AdminManagerUseCase {
	return &AdminManagerUseCase{repo: repo}
}

// ConfigureNewResource now passes context to the repository
func (uc *AdminManagerUseCase) ConfigureNewResource(ctx context.Context, req admin.ResourceConfig, adminRole string) error {
	if adminRole != "System Admin" && adminRole != "Room Admin" {
		return errors.New("unauthorized: only administrators can configure resources")
	}

	if req.Region == "" || req.Location == "" {
		return errors.New("region and location are mandatory parameters")
	}

	return uc.repo.CreateResource(ctx, req)
}

// RegisterSystemHoliday now passes context to the repository
func (uc *AdminManagerUseCase) RegisterSystemHoliday(ctx context.Context, date time.Time, desc string, adminRole string) error {
	if adminRole != "System Admin" {
		return errors.New("unauthorized: only System Admins can manage system-wide holidays")
	}

	holiday := admin.Holiday{
		Date:        date,
		Description: desc,
		IsBlocker:   true,
	}

	return uc.repo.AddHoliday(ctx, holiday)
}

// ValidateHolidayConflict now passes context to the repository
func (uc *AdminManagerUseCase) ValidateHolidayConflict(ctx context.Context, targetDate time.Time) error {
	isHoliday, err := uc.repo.IsDateHoliday(ctx, targetDate)
	if err != nil {
		return err
	}

	if isHoliday {
		return errors.New("booking rejected: the selected date is a designated FSD public holiday")
	}

	return nil
}
