package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/admin"
	"fsd-mrbs/src/domain/booking"

	"github.com/google/uuid"
)

// MessageBroker defines the interface for RabbitMQ PIMM/ICS syncing
type MessageBroker interface {
	Publish(queueName string, message []byte) error
}

// BookingLimitChecker reports whether a user is allowed to create another
// active booking under their tenant's per-period limit. Implemented by the
// admin/tenant repository layer.
type BookingLimitChecker interface {
	WithinLimit(ctx context.Context, tenantID, userID string) (bool, int, error)
}

// ResourceLookup retrieves a resource so the use case can decide whether
// approval is needed and which approvers to notify.
type ResourceLookup interface {
	GetByID(ctx context.Context, id string) (*booking.Resource, error)
}

// ChainMaterializer is implemented by ApprovalChainUseCase. We model it as
// an interface here so create_booking.go doesn't depend on the chain
// package directly (avoids the circular import that would otherwise come
// from the chain depending on the booking domain too).
type ChainMaterializer interface {
	Materialize(ctx context.Context, b booking.Booking, res *booking.Resource) (int, error)
}

type CreateBookingUseCase struct {
	bookingRepo   booking.Repository
	adminRepo     admin.AdminRepository
	resourceRepo  ResourceLookup
	limitChecker  BookingLimitChecker
	chain         ChainMaterializer
	broker        MessageBroker
	zoomMaskBase  string
}

// NewCreateBookingUseCase wires the booking pipeline. resourceRepo and
// limitChecker may be nil for backwards compatibility (tests / older callers);
// the use case degrades gracefully when they are absent.
func NewCreateBookingUseCase(bRepo booking.Repository, aRepo admin.AdminRepository, broker MessageBroker) *CreateBookingUseCase {
	return &CreateBookingUseCase{
		bookingRepo: bRepo,
		adminRepo:   aRepo,
		broker:      broker,
	}
}

// WithResourceLookup attaches a resource repository so approval-required and
// special-room logic can be enforced at booking time.
func (uc *CreateBookingUseCase) WithResourceLookup(r ResourceLookup) *CreateBookingUseCase {
	uc.resourceRepo = r
	return uc
}

// WithLimitChecker attaches a booking-limit policy enforcer.
func (uc *CreateBookingUseCase) WithLimitChecker(c BookingLimitChecker) *CreateBookingUseCase {
	uc.limitChecker = c
	return uc
}

// WithZoomMaskBase configures the static redirect base URL used to mask
// dynamic Zoom/Teams meeting URLs in outbound notifications.
func (uc *CreateBookingUseCase) WithZoomMaskBase(base string) *CreateBookingUseCase {
	uc.zoomMaskBase = base
	return uc
}

// WithChainMaterializer attaches the approval chain. When set, after a
// booking is saved the use case asks the chain whether a multi-level
// rule applies; if so, it materializes the steps and forces the booking
// to PendingApproval status (overriding resource.RequiresApproval).
func (uc *CreateBookingUseCase) WithChainMaterializer(c ChainMaterializer) *CreateBookingUseCase {
	uc.chain = c
	return uc
}

// Request carries all booking inputs from the API layer.
type Request struct {
	TenantID    string
	ResourceID  string
	UserID      string
	Start, End  time.Time
	MeetingURL  string            // optional dynamic Zoom/Teams URL
	CustomData  map[string]string // tenant-defined custom fields
}

// Result describes what was persisted so the caller can decide what to
// show the user (auto-confirmed vs awaiting approval).
type Result struct {
	BookingID        string
	Status           string
	RequiresApproval bool
	RedirectURL      string
}

// Execute orchestrates the FSD booking workflow. The pipeline is:
//
//  1. Tenant + temporal sanity checks
//  2. Holiday blocking (per tenant config)
//  3. Per-user booking limit
//  4. Real-time conflict detection (race-safe via RLS + repo)
//  5. Resource lookup → decide approval required & mask meeting URL
//  6. Persist with optimistic locking
//  7. Publish async event for ICS+SMTP worker
func (uc *CreateBookingUseCase) Execute(ctx context.Context, resourceID, userID string, start, end time.Time) (string, error) {
	res, err := uc.ExecuteRequest(ctx, Request{
		ResourceID: resourceID,
		UserID:     userID,
		Start:      start,
		End:        end,
	})
	if err != nil {
		return "", err
	}
	return res.BookingID, nil
}

// ExecuteRequest is the rich entry point. Execute is kept for backwards
// compatibility with the existing booking handler.
func (uc *CreateBookingUseCase) ExecuteRequest(ctx context.Context, req Request) (Result, error) {
	if !req.End.After(req.Start) {
		return Result{}, errors.New("booking end must be after start")
	}
	if req.Start.Before(time.Now().Add(-1 * time.Minute)) {
		return Result{}, errors.New("booking start must be in the future")
	}

	// 1. Holiday blocking
	isHoliday, err := uc.adminRepo.IsDateHoliday(ctx, req.Start)
	if err != nil {
		return Result{}, errors.New("system error verifying calendar dates")
	}
	if isHoliday {
		return Result{}, errors.New("booking rejected: the selected date is a designated public holiday")
	}

	// 2. Per-user booking limit (best-effort: skip if not wired)
	if uc.limitChecker != nil && req.TenantID != "" {
		ok, limit, err := uc.limitChecker.WithinLimit(ctx, req.TenantID, req.UserID)
		if err != nil {
			return Result{}, errors.New("could not verify booking limit")
		}
		if !ok {
			return Result{}, fmt.Errorf("booking rejected: user has reached the active-booking limit (%d)", limit)
		}
	}

	// 3. Resource lookup (needed before conflict detection so we know the mode)
	requiresApproval := false
	var resource *booking.Resource
	if uc.resourceRepo != nil {
		resource, err = uc.resourceRepo.GetByID(ctx, req.ResourceID)
		if err == nil && resource != nil {
			if !resource.IsActive {
				return Result{}, errors.New("booking rejected: resource is inactive")
			}
			requiresApproval = resource.RequiresApproval
		}
	}

	// 4. Conflict / capacity detection
	//   - exclusive resources: any overlap is a conflict
	//   - shared resources: count concurrent overlaps; reject only if the
	//     count would exceed shared_capacity (gym = 10, classroom = 20, …)
	if resource != nil && resource.IsShared() {
		cap := resource.SharedCapacity
		if cap <= 0 {
			cap = resource.Capacity
		}
		if cap <= 0 {
			cap = 1
		}
		count, err := uc.bookingRepo.CountConcurrent(ctx, req.ResourceID, req.Start, req.End)
		if err != nil {
			return Result{}, fmt.Errorf("capacity check failed: %w", err)
		}
		if count >= cap {
			return Result{}, fmt.Errorf("booking rejected: this slot is already at capacity (%d / %d)", count, cap)
		}
	} else {
		hasConflict, err := uc.bookingRepo.HasConflict(ctx, req.ResourceID, req.Start, req.End)
		if err != nil {
			return Result{}, fmt.Errorf("conflict check failed: %w", err)
		}
		if hasConflict {
			return Result{}, errors.New("booking rejected: a scheduling conflict was detected")
		}
	}

	maskedURL := MaskMeetingURL(req.MeetingURL)
	if uc.zoomMaskBase != "" && req.MeetingURL != "" {
		maskedURL = fmt.Sprintf("%s?target=%s", uc.zoomMaskBase, req.MeetingURL)
	}

	status := booking.StatusConfirmed
	if requiresApproval {
		status = booking.StatusPendingApproval
	}

	// 5. Persist
	bookingMode := booking.BookingModeExclusive
	if resource != nil && resource.IsShared() {
		bookingMode = booking.BookingModeShared
	}
	newBooking := booking.Booking{
		ID:          uuid.New().String(),
		TenantID:    req.TenantID,
		ResourceID:  req.ResourceID,
		UserID:      req.UserID,
		StartTime:   req.Start,
		EndTime:     req.End,
		Status:      status,
		MeetingURL:  req.MeetingURL,
		RedirectURL: maskedURL,
		Version:     1,
		CreatedAt:   time.Now(),
		BookingMode: bookingMode,
	}
	if err := uc.bookingRepo.Save(ctx, newBooking); err != nil {
		if errors.Is(err, booking.ErrConcurrencyConflict) {
			return Result{}, err
		}
		return Result{}, fmt.Errorf("failed to persist booking: %w", err)
	}

	// 6. Multi-level approval chain (best-effort). If a tenant rule
	//    matches this booking we transition it to PendingApproval and
	//    persist one approval_steps row per chain level. The booking
	//    moves to Confirmed only when every step has been approved.
	if uc.chain != nil && resource != nil {
		levels, err := uc.chain.Materialize(ctx, newBooking, resource)
		if err == nil && levels > 0 {
			if newBooking.Status != booking.StatusPendingApproval {
				_ = uc.bookingRepo.UpdateStatus(ctx, newBooking.ID, booking.StatusPendingApproval, "")
				newBooking.Status = booking.StatusPendingApproval
				requiresApproval = true
			}
		}
	}

	// 7. Async fan-out for ICS + SMTP + WebSocket broadcast
	eventName := "BOOKING_CREATED"
	if requiresApproval {
		eventName = "BOOKING_PENDING_APPROVAL"
	}
	payload, _ := json.Marshal(map[string]interface{}{
		"event":       eventName,
		"tenant_id":   newBooking.TenantID,
		"booking_id":  newBooking.ID,
		"resource_id": newBooking.ResourceID,
		"user_id":     newBooking.UserID,
		"start_time":  newBooking.StartTime.Format(time.RFC3339),
		"end_time":    newBooking.EndTime.Format(time.RFC3339),
		"status":      newBooking.Status,
		"meeting_url": maskedURL,
		"custom_data": req.CustomData,
	})
	_ = uc.broker.Publish("booking_events", payload)

	return Result{
		BookingID:        newBooking.ID,
		Status:           newBooking.Status,
		RequiresApproval: requiresApproval,
		RedirectURL:      maskedURL,
	}, nil
}
