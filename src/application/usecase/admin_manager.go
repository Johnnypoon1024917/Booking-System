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

// ConfigureNewResource allows System Admins to deploy new assets to the system.
func (uc *AdminManagerUseCase) ConfigureNewResource(ctx context.Context, req admin.ResourceConfig, adminRole string) error {
	if adminRole != "System Admin" && adminRole != "Room Admin" {
		return errors.New("unauthorized: only administrators can configure resources")
	}

	// Validation logic for FSD specific parameters
	if req.Region == "" || req.Location == "" {
		return errors.New("region and location are mandatory parameters")
	}

	return uc.repo.CreateResource(req)
}

// RegisterSystemHoliday allows admins to manually add holidays to the database.
func (uc *AdminManagerUseCase) RegisterSystemHoliday(ctx context.Context, date time.Time, desc string, adminRole string) error {
	if adminRole != "System Admin" {
		return errors.New("unauthorized: only System Admins can manage system-wide holidays")
	}

	holiday := admin.Holiday{
		Date:        date,
		Description: desc,
		IsBlocker:   true,
	}

	return uc.repo.AddHoliday(holiday)
}

// ValidateHolidayConflict contains the logic to prevent new bookings on holidays.
// This method should be called inside your CreateBookingUseCase before saving to the database.
func (uc *AdminManagerUseCase) ValidateHolidayConflict(ctx context.Context, targetDate time.Time) error {
	isHoliday, err := uc.repo.IsDateHoliday(targetDate)
	if err != nil {
		return err
	}

	if isHoliday {
		return errors.New("booking rejected: the selected date is a designated FSD public holiday")
	}

	return nil
}
