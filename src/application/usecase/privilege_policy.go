package usecase

import (
	"context"
	"encoding/json"
	"strings"

	"fsd-mrbs/src/domain/locationgroup"
	"fsd-mrbs/src/domain/user"
)

// RoleResolver returns the role for a user id (satisfied by the user repo).
type RoleResolver interface {
	GetByID(ctx context.Context, id string) (*user.User, error)
}

// LocationGroupLister lists the tenant's privilege groups (satisfied by the
// location-group repo). Role rows are named "role:<Role>".
type LocationGroupLister interface {
	List(ctx context.Context, tenantID string) ([]locationgroup.LocationGroup, error)
}

const roleGroupPrefix = "role:"

// PrivilegeMatrixPolicy implements PrivilegePolicy by reading the
// "System Privilege Assignment Matrix" persisted as location groups.
type PrivilegeMatrixPolicy struct {
	users  RoleResolver
	groups LocationGroupLister
}

func NewPrivilegeMatrixPolicy(u RoleResolver, g LocationGroupLister) *PrivilegeMatrixPolicy {
	return &PrivilegeMatrixPolicy{users: u, groups: g}
}

// Evaluate resolves the booker's role, finds its privilege row and applies
// the assigned scope + workflow. No row for the role ⇒ no restriction.
func (p *PrivilegeMatrixPolicy) Evaluate(ctx context.Context, tenantID, userID, resourceLocation string) (forceApproval bool, deny bool, reason string, err error) {
	if p.users == nil || p.groups == nil {
		return false, false, "", nil
	}
	u, uerr := p.users.GetByID(ctx, userID)
	if uerr != nil || u == nil || u.Role == "" {
		return false, false, "", nil // unknown user ⇒ don't block here
	}
	groups, gerr := p.groups.List(ctx, tenantID)
	if gerr != nil {
		return false, false, "", nil // policy store unavailable ⇒ fail open
	}
	var row *locationgroup.LocationGroup
	for i := range groups {
		if groups[i].Name == roleGroupPrefix+u.Role {
			row = &groups[i]
			break
		}
	}
	if row == nil {
		return false, false, "", nil // role not in the matrix ⇒ unrestricted
	}

	scope := decodeStringArray(row.Locations)
	if len(scope) > 0 && !containsFold(scope, "All Floors / Locations") &&
		resourceLocation != "" && !containsFold(scope, resourceLocation) {
		return false, true, "role \"" + u.Role + "\" is not assigned to location \"" + resourceLocation + "\"", nil
	}

	switch row.FilterBy {
	case "One-Layer Supervisor Review", "VIP Restricted Authentication":
		return true, false, "", nil
	default: // "Direct Automatic Approval" or anything else
		return false, false, "", nil
	}
}

func decodeStringArray(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

func containsFold(list []string, v string) bool {
	for _, x := range list {
		if strings.EqualFold(strings.TrimSpace(x), strings.TrimSpace(v)) {
			return true
		}
	}
	return false
}
