package booking

import (
	"fsd-mrbs/src/domain/user"
)

// Visibility encodes the three-permission model used by every mature
// booking / calendaring system (Exchange, Google Calendar, Robin):
//
//	visibility ("the resource exists")  → ResourceVisible
//	free/busy  ("the slot is taken")    → CanSeeFreeBusy
//	details    ("who, what, why")       → CanSeeDetails
//
// All read paths (list mine, list admin, busy intervals, detail GET,
// calendar feeds, search results) MUST funnel through this module so
// the three rules stay coupled. The invariant the industry hard-learnt:
// free/busy follows visibility one-for-one; details require an explicit
// extra grant.
//
// The four inputs the policy needs are:
//
//	Caller   — the user making the request (role, id)
//	Resource — the resource the booking is against (owner ACL lives here)
//	Booking  — the row itself (owner id + privacy flag live here)
//	IsAdmin  — derived from role; kept as a helper so test fixtures don't
//	           reinvent the rule
//
// The "default details audience" — owner + System Admin + Security
// Admin + Room Admin + Secretary — matches the original RBAC laid out
// in the FSD spec. The per-resource ACL only widens that set; it can
// never narrow below the floor. System Admin always sees details so an
// audit trail can be reconstructed even on accidentally-restricted
// resources.

// ResourceProjection captures just the fields visibility needs to know
// about the booking's resource. Repos hydrate this once per request to
// avoid re-fetching the row in every policy call.
type ResourceProjection struct {
	ID                   string
	Name                 string // human-readable resource name (not PII)
	IsActive             bool
	IsRestricted         bool
	AssetType            string
	DetailsVisibleToRole []string // additive widening of the details audience
}

// Caller is the auth context the policy reads. Filled from JWT claims
// once at the handler edge; never re-derived inside the policy.
type Caller struct {
	UserID string
	Role   string
	Grade  string
}

// IsSystemAdmin returns true for the role that always sees everything —
// the security backstop for audit reconstruction.
func (c Caller) IsSystemAdmin() bool { return c.Role == user.RoleSystemAdmin }

// IsAdmin returns true for any role that has tenant-wide reach. Used to
// decide whether to surface management actions (cancel-other, mark
// no-show) and to short-circuit per-row visibility checks.
func (c Caller) IsAdmin() bool {
	switch c.Role {
	case user.RoleSystemAdmin, user.RoleSecurityAdmin, user.RoleRoomAdmin, user.RoleSecretary:
		return true
	}
	return false
}

// ResourceVisible answers "does the resource appear in this caller's
// search results?". Mirrors the WHERE clause in
// ResourceRepo.FindAvailable — if either query diverges they MUST be
// updated in lockstep, or the free/busy endpoint will leak presence.
//
//   - Inactive rows are invisible to everyone.
//   - Top Management rows are visible only to Secretary (SDO) and
//     System Admin (System Admin can see everything by role).
//   - is_restricted rows are hidden from General User.
func ResourceVisible(c Caller, r ResourceProjection) bool {
	if !r.IsActive {
		// System Admin can still see inactive rows in the admin UI,
		// but they aren't "visible" for booking purposes. Caller can
		// override via the admin endpoint, not via this function.
		return c.IsSystemAdmin()
	}
	if r.AssetType == "Top Management" {
		if c.IsSystemAdmin() {
			return true
		}
		// Secretary with SDO grade is the FSD-defined gatekeeper for
		// exec resources.
		return c.Role == user.RoleSecretary && c.Grade == "SDO"
	}
	if r.IsRestricted && c.Role == user.RoleGeneralUser {
		return false
	}
	return true
}

// CanSeeFreeBusy answers "may this caller learn this slot is taken?".
// By the industry invariant, this is identical to ResourceVisible —
// every booker who can see the resource must know when it's busy,
// otherwise they hit conflict errors with no warning at submit time.
//
// We keep it as a separately-named function so call sites read clearly
// and so a future "anonymous shared booking" feature has somewhere to
// diverge without re-flowing both endpoints.
func CanSeeFreeBusy(c Caller, r ResourceProjection) bool {
	return ResourceVisible(c, r)
}

// CanSeeDetails answers "may this caller see organiser / subject /
// meeting URL on this booking?". The rules layer top-down:
//
//  1. System Admin: always (backstop for audit).
//  2. Booking owner: always — you can always see your own meeting.
//  3. is_private flag set: blocks everyone else, no matter what
//     resource ACL says. Outlook's "Private appointment" semantic.
//  4. Resource's DetailsVisibleToRole list includes the caller's role:
//     details unlocked.
//  5. Legacy default audience (no per-resource override): Security
//     Admin, Room Admin, Secretary all see details. General User does
//     not — they get the "Reserved" projection.
//
// Note that point 5 means existing behaviour is preserved on resources
// that haven't had the new ACL configured.
func CanSeeDetails(c Caller, b Booking, r ResourceProjection) bool {
	if c.IsSystemAdmin() {
		return true
	}
	if c.UserID != "" && b.UserID == c.UserID {
		return true
	}
	if b.Status == "" {
		// Defensive: a zero-value booking shouldn't leak through —
		// caller forgot to hydrate.
		return false
	}
	// A private booking shuts the door on everyone except 1) and 2).
	// Read the flag from the booking row, not the resource.
	if isPrivate(b) {
		return false
	}
	role := c.Role
	for _, allowed := range r.DetailsVisibleToRole {
		if allowed == role {
			return true
		}
	}
	// Legacy / default audience.
	switch role {
	case user.RoleSecurityAdmin, user.RoleRoomAdmin, user.RoleSecretary:
		return true
	}
	return false
}

// isPrivate is a tiny indirection so the test suite can stub the flag
// without depending on the Booking type's internals at every call site.
// Production reads b.IsPrivate directly.
var isPrivate = func(b Booking) bool { return b.IsPrivate }

// ProjectBooking returns a sanitised copy of `b` for the given caller.
// Always use this at the response edge — never serialise a raw Booking
// to the wire. The projection strips PII fields the caller cannot see
// and replaces them with safe defaults so the UI renders consistently.
//
// What stays for non-details viewers:
//
//	ID, TenantID, ResourceID, StartTime, EndTime, Status, IsRecurring,
//	RecurrenceID, BookingMode, IsPrivate (as a flag the UI can show
//	"🔒 Private" without revealing content).
//
// What gets blanked:
//
//	UserID         — only the owner / details audience sees the owner.
//	Title          — replaced with "" so the UI falls back to
//	                 `t('booking.untitled')` ("Reserved").
//	ExceptionNotes — could contain "Cancelled — confidential VIP visit".
//	MeetingURL     — usually carries secrets in its query string.
//	RedirectURL    — same.
//	CheckedInAt    — pattern of check-ins reveals occupancy of
//	                 sensitive rooms; the busy interval already conveys
//	                 the slot, so this adds nothing.
func ProjectBooking(c Caller, b Booking, r ResourceProjection) Booking {
	// The resource name is not PII — the resource_id is already exposed on
	// every busy interval — so surface it on every projection. This is what
	// lets the SPA show a human-readable room name instead of a raw UUID
	// even when the caller cannot enumerate the full resource catalogue.
	b.ResourceName = r.Name
	if CanSeeDetails(c, b, r) {
		return b
	}
	out := Booking{
		ID:           b.ID,
		TenantID:     b.TenantID,
		ResourceID:   b.ResourceID,
		ResourceName: b.ResourceName,
		StartTime:    b.StartTime,
		EndTime:      b.EndTime,
		Status:       b.Status,
		IsRecurring:  b.IsRecurring,
		RecurrenceID: b.RecurrenceID,
		Version:      b.Version,
		CreatedAt:    b.CreatedAt,
		BookingMode:  b.BookingMode,
		IsPrivate:    b.IsPrivate,
		// PII fields explicitly NOT carried over.
	}
	return out
}

// ProjectMany applies ProjectBooking across a slice, looking up the
// per-resource projection from the supplied map. Unknown resources are
// projected with a permissive default (legacy behaviour) so the
// missing-row case never accidentally leaks details — the worst case is
// a too-strict projection, not a too-loose one.
func ProjectMany(c Caller, bs []Booking, resourcesByID map[string]ResourceProjection) []Booking {
	out := make([]Booking, 0, len(bs))
	for _, b := range bs {
		r, ok := resourcesByID[b.ResourceID]
		if !ok {
			r = ResourceProjection{ID: b.ResourceID, IsActive: true}
		}
		out = append(out, ProjectBooking(c, b, r))
	}
	return out
}
