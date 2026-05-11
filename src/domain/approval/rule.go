package approval

import (
	"context"
	"time"
)

// Scope kinds — what a rule applies to.
const (
	ScopeAssetType  = "asset_type"
	ScopeResource   = "resource"
	ScopeDepartment = "department"
	ScopeTenant     = "tenant"
)

// Step kinds — how each level identifies its approvers.
const (
	StepStatusPending  = "pending"
	StepStatusApproved = "approved"
	StepStatusRejected = "rejected"
	StepStatusSkipped  = "skipped"
)

// Level describes one tier of an approval chain. At least one of
// ApproverUserIDs / ApproverRole / MinGrade must be set; the use case
// resolves these into a concrete list of allowed deciders at runtime.
//
// AutoAfterHours is the SLA escalation: if the level is still pending
// after this many hours, the use case marks it auto-approved (and writes
// an audit entry noting it was the SLA, not a human, that decided).
type Level struct {
	Name             string   `json:"name"`
	ApproverUserIDs  []string `json:"approver_user_ids,omitempty"`
	ApproverRole     string   `json:"approver_role,omitempty"`
	MinGrade         string   `json:"min_grade,omitempty"`
	AutoAfterHours   int      `json:"auto_after_hours,omitempty"`
	// Dependencies lists zero-based indices of earlier levels in the same
	// chain that must complete (approved or skipped) before this level
	// becomes actionable. Empty = depends on the immediately previous level
	// (the legacy linear behaviour). Allows fan-in / parallel branches:
	// e.g. level 2 depends on [0,1] = both 0 and 1 must approve before 2.
	// A level whose deps are all "skipped" itself becomes "skipped".
	Dependencies []int `json:"dependencies,omitempty"`
	// Parallel is a UI hint that this level can be presented to all eligible
	// approvers at once (any-of) — the chain still completes when one of
	// them approves. The use case treats this as informational; the
	// approver-resolution logic already supports any-of-N.
	Parallel bool `json:"parallel,omitempty"`
}

// Rule is a tenant-configured policy: "if a booking matches this scope,
// route it through these levels in this order". Rules are evaluated by
// priority (lowest first), so a specific resource rule can override the
// asset-type default.
type Rule struct {
	ID         string
	TenantID   string
	Name       string
	ScopeType  string // ScopeAssetType / ScopeResource / ScopeDepartment / ScopeTenant
	ScopeValue string // empty for tenant-wide
	Priority   int
	Levels     []Level
	IsActive   bool
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// RuleRepository persists Rule rows.
type RuleRepository interface {
	List(ctx context.Context, tenantID string) ([]Rule, error)
	Get(ctx context.Context, id string) (*Rule, error)
	Save(ctx context.Context, r Rule) error
	Delete(ctx context.Context, id string) error
}

// Step is a concrete instantiation of a Level for one specific booking.
type Step struct {
	ID            string
	TenantID      string
	BookingID     string
	RuleID        string
	StepIndex     int
	LevelName     string
	ApproverIDs   []string
	ApproverRole  string
	MinGrade      string
	Status        string // StepStatusPending / Approved / Rejected / Skipped
	DecidedBy     string
	DecisionAt    *time.Time
	Reason        string
	DueAt         *time.Time
	CreatedAt     time.Time
}

// StepRepository persists Step rows.
type StepRepository interface {
	Save(ctx context.Context, s Step) error
	UpdateDecision(ctx context.Context, id, status, decidedBy, reason string, when time.Time) error
	ListByBooking(ctx context.Context, bookingID string) ([]Step, error)
	ListPending(ctx context.Context, tenantID string) ([]Step, error)
}
