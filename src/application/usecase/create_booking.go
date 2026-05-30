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

// ErrInternal marks an error as an internal/server failure (DB outage,
// downstream service) rather than a user-input problem. Handlers map it to a
// 5xx so the surrounding per-request transaction (middleware.WithTenantTx)
// rolls back any partially-persisted state. Wrap underlying errors with %w.
var ErrInternal = errors.New("internal booking error")

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

// PrivilegePolicy enforces the FSD "Room Privilege Setup by Organisation
// Hierarchy" matrix at booking time: it maps the booker's role to an
// assigned location scope and an approval workflow. Returns whether the
// booking must be denied (out of scope) or forced into approval.
type PrivilegePolicy interface {
	Evaluate(ctx context.Context, tenantID, userID, resourceLocation string) (forceApproval bool, deny bool, reason string, err error)
}

type CreateBookingUseCase struct {
	bookingRepo  booking.Repository
	validator    *BookingValidator
	limitChecker BookingLimitChecker
	chain        ChainMaterializer
	broker       MessageBroker
	zoomMaskBase string
}

// NewCreateBookingUseCase wires the booking pipeline. resourceRepo and
// limitChecker may be nil for backwards compatibility (tests / older callers);
// the use case degrades gracefully when they are absent. Holiday, capacity and
// privilege checks live in the shared BookingValidator so update_booking.go
// enforces the same rules.
func NewCreateBookingUseCase(bRepo booking.Repository, aRepo admin.AdminRepository, broker MessageBroker) *CreateBookingUseCase {
	return &CreateBookingUseCase{
		bookingRepo: bRepo,
		validator:   NewBookingValidator(bRepo, aRepo),
		broker:      broker,
	}
}

// Validator exposes the shared validator so it can be handed to the update
// use case, keeping a single source of truth for booking rules.
func (uc *CreateBookingUseCase) Validator() *BookingValidator { return uc.validator }

// WithResourceLookup attaches a resource repository so approval-required and
// special-room logic can be enforced at booking time.
func (uc *CreateBookingUseCase) WithResourceLookup(r ResourceLookup) *CreateBookingUseCase {
	uc.validator.WithResourceLookup(r)
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

// WithPrivilegePolicy attaches the org-hierarchy privilege matrix. When
// set, the booker's role scope/workflow is enforced before persistence.
func (uc *CreateBookingUseCase) WithPrivilegePolicy(p PrivilegePolicy) *CreateBookingUseCase {
	uc.validator.WithPrivilegePolicy(p)
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
	TenantID   string
	ResourceID string
	UserID     string
	Start, End time.Time
	MeetingURL string            // optional dynamic Zoom/Teams URL
	Title      string            // meeting subject shown on calendars
	IsPrivate  bool              // Outlook-style "Private" flag — strips PII for non-owners
	CustomData map[string]string // tenant-defined custom fields
	Services   []ServiceRequest  // ADDED: List of requested services
}

// ServiceRequest represents a service item to be added to a booking.
type ServiceRequest struct {
	ServiceID string `json:"service_id"`
	Quantity  int    `json:"quantity"`
	Notes     string `json:"notes"`
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
func (uc *CreateBookingUseCase) Execute(ctx context.Context, resourceID, userID string, start, end time.Time, tenantID string) (string, error) {
	res, err := uc.ExecuteRequest(ctx, Request{
		ResourceID: resourceID,
		UserID:     userID,
		Start:      start,
		End:        end,
		TenantID:   tenantID,
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

	// Reject malformed service lines up front (audit #5) so we never persist a
	// booking whose services would then be rejected.
	for _, s := range req.Services {
		if s.Quantity <= 0 {
			return Result{}, fmt.Errorf("booking rejected: service %s quantity must be positive", s.ServiceID)
		}
	}

	// Per-user booking limit (create-only; best-effort: skip if not wired).
	if uc.limitChecker != nil && req.TenantID != "" {
		ok, limit, err := uc.limitChecker.WithinLimit(ctx, req.TenantID, req.UserID)
		if err != nil {
			return Result{}, fmt.Errorf("could not verify booking limit: %s: %w", err, ErrInternal)
		}
		if !ok {
			return Result{}, fmt.Errorf("booking rejected: user has reached the active-booking limit (%d)", limit)
		}
	}

	// Holiday blocking + conflict/shared-capacity detection (race-safe via a
	// FOR UPDATE lock on shared resources) + org-hierarchy privilege matrix.
	// Shared with the update use case so a reschedule can't bypass them
	// (audit #1, #2).
	vres, err := uc.validator.Validate(ctx, ValidationInput{
		TenantID:   req.TenantID,
		UserID:     req.UserID,
		ResourceID: req.ResourceID,
		Start:      req.Start,
		End:        req.End,
	})
	if err != nil {
		return Result{}, err
	}
	resource := vres.Resource
	requiresApproval := vres.RequiresApproval

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
		Title:       req.Title,
		IsPrivate:   req.IsPrivate,
	}
	if err := uc.bookingRepo.Save(ctx, newBooking); err != nil {
		if errors.Is(err, booking.ErrConcurrencyConflict) {
			return Result{}, err
		}
		return Result{}, fmt.Errorf("failed to persist booking: %s: %w", err, ErrInternal)
	}

	// Attach services. We run inside the per-request transaction
	// (middleware.WithTenantTx), so returning an error here rolls the whole
	// booking back rather than leaving a row whose paid services silently
	// vanished (audit #3). Quantities were validated above.
	for _, s := range req.Services {
		if err := uc.bookingRepo.AddServiceToBooking(ctx, newBooking.ID, s.ServiceID, s.Quantity, s.Notes); err != nil {
			return Result{}, fmt.Errorf("could not attach service %s: %s: %w", s.ServiceID, err, ErrInternal)
		}
	}

	// 6. Multi-level approval chain. If a tenant rule matches this booking we
	//    transition it to PendingApproval and persist one approval_steps row
	//    per chain level. Fail closed (audit #4): a chain error rolls the
	//    booking back instead of silently confirming it. Materialize returns
	//    (0, nil) — not an error — when no chain applies, so the no-chain path
	//    is unaffected.
	if uc.chain != nil && resource != nil {
		levels, err := uc.chain.Materialize(ctx, newBooking, resource)
		if err != nil {
			return Result{}, fmt.Errorf("could not process approval chain: %s: %w", err, ErrInternal)
		}
		if levels > 0 && newBooking.Status != booking.StatusPendingApproval {
			if err := uc.bookingRepo.UpdateStatus(ctx, newBooking.ID, booking.StatusPendingApproval, ""); err != nil {
				return Result{}, fmt.Errorf("could not set approval status: %s: %w", err, ErrInternal)
			}
			newBooking.Status = booking.StatusPendingApproval
			requiresApproval = true
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
