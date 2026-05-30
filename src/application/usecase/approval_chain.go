package usecase

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"fsd-mrbs/src/domain/approval"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/user"

	"github.com/google/uuid"
)

// ApprovalChainUseCase materializes a multi-level approval chain on
// booking creation, then advances it as approvers act.
//
// Selection of which rule applies is "first match by priority":
//
//   1. If any rule's scope is ScopeResource and matches booking.ResourceID
//   2. Else if any rule's scope is ScopeAssetType and matches booking.AssetType
//   3. Else if any rule's scope is ScopeDepartment and matches booking's resource department
//   4. Else any rule with ScopeTenant
//   5. Else fall back to the legacy single-level resource.RequiresApproval
//
// When no rule matches and the resource doesn't require approval, the
// booking is auto-confirmed by the create-booking pipeline (unchanged).
type ApprovalChainUseCase struct {
	rules     approval.RuleRepository
	steps     approval.StepRepository
	resources booking.ResourceRepository
	bookings  booking.Repository
	approvals approval.Repository
}

func NewApprovalChainUseCase(
	rules approval.RuleRepository,
	steps approval.StepRepository,
	resources booking.ResourceRepository,
	bookings booking.Repository,
	approvals approval.Repository,
) *ApprovalChainUseCase {
	return &ApprovalChainUseCase{rules: rules, steps: steps, resources: resources, bookings: bookings, approvals: approvals}
}

// Materialize is called from CreateBooking after the booking row is saved.
// It evaluates rules and writes one approval_steps row per chain level.
// Returns the chain length (0 = auto-confirmed, no chain).
func (uc *ApprovalChainUseCase) Materialize(ctx context.Context, b booking.Booking, res *booking.Resource) (int, error) {
	rule, err := uc.matchRule(ctx, b.TenantID, res)
	if err != nil {
		return 0, err
	}
	if rule == nil {
		// No tenant-configured chain → fall back to single-level legacy
		// behavior already handled by CreateBooking.
		return 0, nil
	}
	if len(rule.Levels) == 0 {
		return 0, nil
	}

	now := time.Now()
	for i, lvl := range rule.Levels {
		var dueAt *time.Time
		if lvl.AutoAfterHours > 0 {
			t := now.Add(time.Duration(lvl.AutoAfterHours) * time.Hour)
			dueAt = &t
		}
		s := approval.Step{
			ID:           uuid.NewString(),
			TenantID:     b.TenantID,
			BookingID:    b.ID,
			RuleID:       rule.ID,
			StepIndex:    i,
			LevelName:    lvl.Name,
			ApproverIDs:  lvl.ApproverUserIDs,
			ApproverRole: lvl.ApproverRole,
			MinGrade:     lvl.MinGrade,
			Status:       approval.StepStatusPending,
			DueAt:        dueAt,
			CreatedAt:    now,
		}
		if err := uc.steps.Save(ctx, s); err != nil {
			return 0, err
		}
	}
	return len(rule.Levels), nil
}

// Decide is called by the approval handler when a user clicks
// approve / reject. It finds the first pending step the user is allowed
// to act on, transitions it, and either advances to the next level
// (booking stays Pending) or completes the chain (booking → Confirmed
// or Cancelled).
func (uc *ApprovalChainUseCase) Decide(ctx context.Context, bookingID string, decider *user.User, status, reason string) error {
	if status != approval.StepStatusApproved && status != approval.StepStatusRejected {
		return errors.New("status must be approved or rejected")
	}
	steps, err := uc.steps.ListByBooking(ctx, bookingID)
	if err != nil {
		return err
	}
	if len(steps) == 0 {
		return errors.New("no chain on this booking")
	}

	// Resolve the rule (if still present) so we can honor per-level
	// dependencies — empty deps fall back to "previous level must be done"
	// (legacy linear). The lookup is best-effort: a deleted rule means we
	// gracefully degrade to the linear fan-in. We log the degradation so
	// an admin can spot it in the API logs (silently dropping fan-in
	// branches has confused on-call before).
	var rule *approval.Rule
	if len(steps) > 0 && steps[0].RuleID != "" {
		var lookupErr error
		rule, lookupErr = uc.rules.Get(ctx, steps[0].RuleID)
		if lookupErr != nil {
			log.Printf("approval chain: rule %s missing for booking %s (degrading to linear): %v",
				steps[0].RuleID, bookingID, lookupErr)
		}
	}
	depsSatisfied := func(idx int) bool {
		var deps []int
		if rule != nil && idx < len(rule.Levels) {
			deps = rule.Levels[idx].Dependencies
		}
		if len(deps) == 0 {
			// linear: previous step must be done (approved or skipped)
			if idx == 0 {
				return true
			}
			prev := steps[idx-1]
			return prev.Status == approval.StepStatusApproved || prev.Status == approval.StepStatusSkipped
		}
		for _, d := range deps {
			if d < 0 || d >= len(steps) {
				return false
			}
			if steps[d].Status != approval.StepStatusApproved && steps[d].Status != approval.StepStatusSkipped {
				return false
			}
		}
		return true
	}

	var pending *approval.Step
	for i := range steps {
		if steps[i].Status != approval.StepStatusPending {
			continue
		}
		if !depsSatisfied(i) {
			continue
		}
		if !canDecide(&steps[i], decider) {
			continue
		}
		pending = &steps[i]
		break
	}
	if pending == nil {
		return errors.New("no actionable approval step for this user")
	}

	if err := uc.steps.UpdateDecision(ctx, pending.ID, status, decider.ID, reason, time.Now()); err != nil {
		return err
	}

	// Audit row for this decision
	_ = uc.approvals.Save(ctx, approval.Approval{
		ID:         uuid.NewString(),
		TenantID:   pending.TenantID,
		BookingID:  bookingID,
		ApproverID: decider.ID,
		Decision:   status,
		Reason:     reason,
		DecidedAt:  time.Now(),
	})

	// If rejected → cancel the booking outright.
	if status == approval.StepStatusRejected {
		return uc.bookings.UpdateStatus(ctx, bookingID, "Cancelled", "Rejected at "+pending.LevelName+": "+reason)
	}

	// Approved → check whether all remaining steps are done.
	allApproved := true
	for _, s := range steps {
		if s.ID == pending.ID {
			continue
		}
		if s.Status != approval.StepStatusApproved && s.Status != approval.StepStatusSkipped {
			allApproved = false
			break
		}
	}
	if allApproved {
		return uc.bookings.UpdateStatus(ctx, bookingID, booking.StatusConfirmed, "")
	}
	return nil
}

// matchRule walks the tenant's active rules in priority order and returns
// the first one that applies to the given booking/resource.
func (uc *ApprovalChainUseCase) matchRule(ctx context.Context, tenantID string, res *booking.Resource) (*approval.Rule, error) {
	rules, err := uc.rules.List(ctx, tenantID)
	if err != nil {
		return nil, err
	}
	for i := range rules {
		r := &rules[i]
		if !r.IsActive {
			continue
		}
		if matches(r, res) {
			return r, nil
		}
	}
	return nil, nil
}

func matches(r *approval.Rule, res *booking.Resource) bool {
	switch r.ScopeType {
	case approval.ScopeResource:
		return res != nil && res.ID == r.ScopeValue
	case approval.ScopeAssetType:
		return res != nil && res.AssetType == r.ScopeValue
	case approval.ScopeDepartment:
		return res != nil && res.DepartmentID == r.ScopeValue
	case approval.ScopeTenant:
		return r.ScopeValue == ""
	}
	return false
}

// canDecide checks whether the given user is allowed to act on a step.
// Match if:
//   - their user ID is in the explicit approver list (grade gate still applies), OR
//   - they hold the required role and meet min_grade if specified, OR
//   - the step has no specific approvers AND user is a System Admin
//
// MinGrade is a *minimum* — anyone at or above the configured grade
// satisfies it (see user.GradeAtLeast). Previously this was an equality
// check, which silently rejected approvers at higher grades than the rule
// required and made multi-tier chains unusable.
func canDecide(step *approval.Step, u *user.User) bool {
	if u == nil {
		return false
	}
	for _, id := range step.ApproverIDs {
		if id == u.ID {
			return user.GradeAtLeast(u.Grade, step.MinGrade)
		}
	}
	if step.ApproverRole != "" && strings.EqualFold(step.ApproverRole, u.Role) {
		return user.GradeAtLeast(u.Grade, step.MinGrade)
	}
	if u.Role == user.RoleSystemAdmin && len(step.ApproverIDs) == 0 && step.ApproverRole == "" {
		return true
	}
	return false
}
