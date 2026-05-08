package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"fsd-mrbs/src/domain/admin"
	"fsd-mrbs/src/domain/booking"

	"github.com/google/uuid"
)

// MessageBroker defines the interface for RabbitMQ PIMM/ICS syncing
type MessageBroker interface {
	Publish(queueName string, message []byte) error
}

type CreateBookingUseCase struct {
	bookingRepo booking.Repository
	adminRepo   admin.AdminRepository
	broker      MessageBroker
}

func NewCreateBookingUseCase(bRepo booking.Repository, aRepo admin.AdminRepository, broker MessageBroker) *CreateBookingUseCase {
	return &CreateBookingUseCase{
		bookingRepo: bRepo,
		adminRepo:   aRepo,
		broker:      broker,
	}
}

// Execute orchestrates the strict FSD booking workflow
func (uc *CreateBookingUseCase) Execute(ctx context.Context, resourceID, userID string, start, end time.Time) (string, error) {
	// -------------------------------------------------------------------------
	// 1. HOLIDAY VALIDATION CHECK
	// -------------------------------------------------------------------------
	isHoliday, err := uc.adminRepo.IsDateHoliday(ctx, start)
	if err != nil {
		return "", errors.New("system error verifying calendar dates")
	}
	if isHoliday {
		return "", errors.New("booking rejected: the selected date is a designated FSD public holiday")
	}

	// -------------------------------------------------------------------------
	// 2. REAL-TIME AVAILABILITY VALIDATION
	// -------------------------------------------------------------------------
	// In a production scenario, we do a final targeted query here to ensure
	// no one else booked this exact resource in the last few milliseconds.
	hasConflict, err := uc.bookingRepo.HasConflict(ctx, resourceID, start, end)
	if err != nil {
		return "", errors.New("database verification failed")
	}
	if hasConflict {
		return "", errors.New("booking rejected: a scheduling conflict was detected")
	}

	// -------------------------------------------------------------------------
	// 3. ENTITY CREATION & PERSISTENCE
	// -------------------------------------------------------------------------
	newBooking := booking.Booking{
		ID:         uuid.New().String(),
		ResourceID: resourceID,
		UserID:     userID,
		StartTime:  start,
		EndTime:    end,
		Status:     booking.StatusConfirmed, // Defaults to Confirmed unless it's a Special Room
		Version:    1,
		CreatedAt:  time.Now(),
	}

	err = uc.bookingRepo.Save(ctx, newBooking)
	if err != nil {
		return "", errors.New("failed to persist booking due to optimistic locking conflict")
	}

	// -------------------------------------------------------------------------
	// 4. ASYNCHRONOUS INTEGRATION (RabbitMQ)
	// -------------------------------------------------------------------------
	// Dispatch event for ICS generation and PIMM syncing without blocking the user
	eventPayload, _ := json.Marshal(map[string]interface{}{
		"event":       "BOOKING_CREATED",
		"booking_id":  newBooking.ID,
		"resource_id": newBooking.ResourceID,
		"user_id":     newBooking.UserID,
		"start_time":  newBooking.StartTime.Format(time.RFC3339),
		"end_time":    newBooking.EndTime.Format(time.RFC3339),
	})

	// Fire and forget; errors here shouldn't fail the booking that's already in Postgres
	_ = uc.broker.Publish("pimm_sync_queue", eventPayload)

	return newBooking.ID, nil
}
