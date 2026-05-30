// Package locationgroup models the "Room Privilege Setup by Organisation
// Hierarchy" feature from the FSD spec: a named user group that grants a
// set of users (resolved via a filter) access to a set of locations, with
// optional approver routing.
//
// approvers and locations are opaque JSON string arrays — the SPA owns
// their shape and the backend stores/returns them untouched, matching the
// same JSONB-blob convention used by floor plans.
package locationgroup

import (
	"context"
	"encoding/json"
	"time"
)

type LocationGroup struct {
	ID        string          `json:"ID"`
	TenantID  string          `json:"TenantID"`
	Name      string          `json:"Name"`
	FilterBy  string          `json:"FilterBy"`  // Whitelist | Channel | Department
	Approvers json.RawMessage `json:"Approvers"` // ["a@fsd.gov.hk", ...]
	Locations json.RawMessage `json:"Locations"` // ["FSD HQ 33F", ...]
	Status    string          `json:"Status"`    // Active | Inactive
	CreatedAt time.Time       `json:"CreatedAt"`
	UpdatedAt time.Time       `json:"UpdatedAt"`
}

type Repository interface {
	List(ctx context.Context, tenantID string) ([]LocationGroup, error)
	Create(ctx context.Context, g LocationGroup) (LocationGroup, error)
	Update(ctx context.Context, g LocationGroup) (LocationGroup, error)
	Delete(ctx context.Context, tenantID, id string) error
}
