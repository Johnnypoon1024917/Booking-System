package booking

import (
	"context"
	"fsd-mrbs/src/domain/user"
	"time"
)

// Booking mode values describe how a resource handles overlapping bookings.
//
// "exclusive" — the legacy default. Only one booking may hold the resource
//   for a given time window. Enforced by the bookings_no_overlap EXCLUDE
//   constraint at the DB level.
// "shared" — the resource (gym, classroom, drop-in zone, …) admits up to
//   `shared_capacity` concurrent bookings for the same window. The DB
//   constraint skips these rows; the use case enforces capacity instead.
const (
	BookingModeExclusive = "exclusive"
	BookingModeShared    = "shared"
)

// Composite mode values describe a resource's role within a parent/child split.
//
// A "parent" resource (e.g. a basketball court) is the larger, default unit.
// A "child" resource (e.g. one badminton court) lives inside it. Booking the
// parent blocks all children for the same time window; booking any child
// blocks the parent. Siblings don't block each other — that's the whole point
// of the split.
const (
	CompositeStandalone = ""
	CompositeParent     = "parent"
	CompositeChild      = "child"
)

// Resource represents a bookable asset within the system.
// Resources can be Rooms, Vehicles, Equipment, Top Management schedules,
// or composite parent/child splits (e.g. one basketball court that re-skins
// into three badminton courts).
type Resource struct {
	ID               string
	TenantID         string
	Name             string
	AssetType        string
	Region           string
	Location         string
	Capacity         int
	Equipment        []string
	IsRestricted     bool
	RequiresApproval bool
	ApproverIDs      []string
	SecretaryIDs     []string
	Metadata         map[string]interface{}
	IsActive         bool
	Version          int

	// Composite / split-room support
	ParentResourceID string // empty if this is a standalone or top-level resource
	CompositeMode    string // CompositeStandalone | CompositeParent | CompositeChild
	SubResourceCount int    // number of children when CompositeMode == CompositeParent

	// Capacity-shared bookings: when BookingMode == "shared", up to
	// SharedCapacity concurrent bookings can hold the resource for the
	// same time window. Defaults to "exclusive" for backwards compat.
	BookingMode    string // BookingModeExclusive | BookingModeShared
	SharedCapacity int    // only meaningful when BookingMode == BookingModeShared

	// Theming hints surfaced in the SPA
	Color string
	Icon  string

	// Optional grouping for admin reporting
	DepartmentID string
}

// IsShared reports whether this resource admits multiple concurrent bookings.
func (r *Resource) IsShared() bool { return r.BookingMode == BookingModeShared }

// SearchCriteria defines the parameters for resource search
type SearchCriteria struct {
	StartTime time.Time
	EndTime   time.Time
	TenantID  string
	Region    string
	Capacity  int
	AssetType string
}

// IsParent returns true when this resource has child sub-resources.
func (r *Resource) IsParent() bool { return r.CompositeMode == CompositeParent }

// IsChild returns true when this resource is part of a parent split.
func (r *Resource) IsChild() bool { return r.CompositeMode == CompositeChild }

// ResourceRepository defines the interface for resource persistence
type ResourceRepository interface {
	FindAvailable(ctx context.Context, criteria SearchCriteria, requestingUser user.User) ([]Resource, error)
	GetByID(ctx context.Context, id string) (*Resource, error)
	Save(ctx context.Context, r Resource) error
	ListByTenant(ctx context.Context, tenantID string) ([]Resource, error)
	ListChildren(ctx context.Context, parentID string) ([]Resource, error)
	Deactivate(ctx context.Context, id string) error
	GetOperatingHours(ctx context.Context, resourceID string) ([]OperatingHours, error)
	SetOperatingHours(ctx context.Context, hours []OperatingHours) error
}
