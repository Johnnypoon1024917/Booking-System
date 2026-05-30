package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/admin"
	"fsd-mrbs/src/domain/booking"
)

// BookingValidator centralises the business rules that must hold whenever a
// booking's time window is established — at creation *and* whenever an update
// reschedules it. Previously these checks lived only in CreateBookingUseCase,
// so UpdateBookingUseCase silently bypassed holiday blocking, shared-capacity
// limits and the org-hierarchy privilege matrix (audit findings #1, #2). Both
// use cases now route time changes through Validate so the rules are enforced
// in exactly one place.
//
// All collaborators are optional: a nil dependency means that particular check
// is skipped, preserving the "degrade gracefully when not wired" behaviour the
// create pipeline already relied on (tests, older callers).
type BookingValidator struct {
	bookingRepo  booking.Repository
	adminRepo    admin.AdminRepository
	resourceRepo ResourceLookup
	privilege    PrivilegePolicy
}

func NewBookingValidator(bookingRepo booking.Repository, adminRepo admin.AdminRepository) *BookingValidator {
	return &BookingValidator{bookingRepo: bookingRepo, adminRepo: adminRepo}
}

func (v *BookingValidator) WithResourceLookup(r ResourceLookup) *BookingValidator {
	v.resourceRepo = r
	return v
}

func (v *BookingValidator) WithPrivilegePolicy(p PrivilegePolicy) *BookingValidator {
	v.privilege = p
	return v
}

// ValidationInput carries the (resource, time, actor) tuple to be checked.
// ExcludeBookingID is the id of the booking being rescheduled; it is omitted
// from the shared-capacity tally so a booking is not counted against itself.
// Leave it empty on create.
type ValidationInput struct {
	TenantID         string
	UserID           string
	ResourceID       string
	Start, End       time.Time
	ExcludeBookingID string
}

// ValidationResult reports the resource that was resolved (so the caller can
// avoid a second lookup) and whether policy forces the booking into approval.
type ValidationResult struct {
	Resource         *booking.Resource
	RequiresApproval bool
}

// Validate runs holiday blocking, conflict/shared-capacity detection and the
// org-hierarchy privilege matrix. It must be called inside the per-request
// transaction so the FOR UPDATE lock on shared resources actually serializes
// concurrent bookings (see LockResourceForUpdate). Returns a user-safe error
// describing the first rule that rejected the booking.
func (v *BookingValidator) Validate(ctx context.Context, in ValidationInput) (ValidationResult, error) {
	var out ValidationResult

	// 1. Holiday blocking (per tenant config).
	if v.adminRepo != nil {
		isHoliday, err := v.adminRepo.IsDateHoliday(ctx, in.Start)
		if err != nil {
			return out, fmt.Errorf("system error verifying calendar dates: %s: %w", err, ErrInternal)
		}
		if isHoliday {
			return out, errors.New("booking rejected: the selected date is a designated public holiday")
		}
	}

	// 2. Resource lookup — needed to know the booking mode and approval flag.
	var resource *booking.Resource
	if v.resourceRepo != nil {
		res, err := v.resourceRepo.GetByID(ctx, in.ResourceID)
		if err == nil && res != nil {
			if !res.IsActive {
				return out, errors.New("booking rejected: resource is inactive")
			}
			resource = res
			out.RequiresApproval = res.RequiresApproval
		}
	}
	out.Resource = resource

	// 3. Conflict / capacity detection.
	//   - shared resources: lock the resource row, then count concurrent
	//     overlaps and reject if the slot is full. The lock closes the
	//     TOCTOU window between this count and the eventual Save.
	//   - exclusive resources: an app-level overlap check on create. On
	//     update (ExcludeBookingID set) we rely on the bookings_no_overlap
	//     EXCLUDE constraint at Save time, which correctly excludes the row
	//     being updated from the comparison.
	if resource != nil && resource.IsShared() {
		cap := resource.SharedCapacity
		if cap <= 0 {
			cap = resource.Capacity
		}
		if cap <= 0 {
			cap = 1
		}
		if err := v.bookingRepo.LockResourceForUpdate(ctx, in.ResourceID); err != nil {
			return out, fmt.Errorf("capacity check failed: %s: %w", err, ErrInternal)
		}
		count, err := v.bookingRepo.CountConcurrent(ctx, in.ResourceID, in.Start, in.End, in.ExcludeBookingID)
		if err != nil {
			return out, fmt.Errorf("capacity check failed: %s: %w", err, ErrInternal)
		}
		if count >= cap {
			return out, fmt.Errorf("booking rejected: this slot is already at capacity (%d / %d)", count, cap)
		}
	} else if in.ExcludeBookingID == "" {
		hasConflict, err := v.bookingRepo.HasConflict(ctx, in.ResourceID, in.Start, in.End)
		if err != nil {
			return out, fmt.Errorf("conflict check failed: %s: %w", err, ErrInternal)
		}
		if hasConflict {
			return out, errors.New("booking rejected: a scheduling conflict was detected")
		}
	}

	// 4. Org-hierarchy privilege matrix. Out-of-scope bookings are denied;
	//    restricted/supervisor workflows force approval.
	if v.privilege != nil && in.TenantID != "" {
		loc := ""
		if resource != nil {
			loc = resource.Location
		}
		force, deny, reason, perr := v.privilege.Evaluate(ctx, in.TenantID, in.UserID, loc)
		if perr == nil {
			if deny {
				return out, fmt.Errorf("booking rejected: %s", reason)
			}
			if force {
				out.RequiresApproval = true
			}
		}
	}

	return out, nil
}
