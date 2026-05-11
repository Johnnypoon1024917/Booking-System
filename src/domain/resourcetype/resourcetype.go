// Package resourcetype models the admin-extensible asset-type catalog.
//
// The legacy hard-coded set was {Room, Vehicle, Equipment, Top Management}.
// Tenants can now add their own (Gym, Studio, Boat, Drone, Parking…) with
// their own default capacity, booking mode, icon, and approval policy.
// The built-ins remain present in code as a floor; this catalog supplements
// them per-tenant.
package resourcetype

import "context"

type ResourceType struct {
	ID                      string
	TenantID                string
	Key                     string
	Label                   string
	Icon                    string
	Color                   string
	DefaultCapacity         int
	DefaultBookingMode      string // "exclusive" | "shared"
	DefaultRequiresApproval bool
	DisplayOrder            int
	IsBuiltin               bool
	IsActive                bool
}

type Repository interface {
	List(ctx context.Context, tenantID string) ([]ResourceType, error)
	Get(ctx context.Context, tenantID, key string) (*ResourceType, error)
	Save(ctx context.Context, t ResourceType) error
	Delete(ctx context.Context, tenantID, key string) error
}
