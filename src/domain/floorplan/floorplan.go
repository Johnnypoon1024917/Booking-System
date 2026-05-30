// Package floorplan owns the admin-drawn floor plan that backs the
// interactive floor plan view in the admin booking screen.
//
// Multiple plans per tenant are supported so an organisation can model
// several physical spaces (Floor 1, Floor 2, Annex), and an admin can
// duplicate an existing plan as a starting point for a new one.
package floorplan

import (
	"context"
	"encoding/json"
	"time"
)

// FloorPlan is a single admin-drawn floor plan. Both shapes and pins are
// opaque JSON blobs — the SPA owns their schema (rect / line / label for
// shapes; {resource_id, x, y} for pins) and the backend just stores and
// returns them untouched. Keeping these frontend-defined means we never
// need a DB migration for a new drawing primitive.
//
// Pins are per-plan: switching the active plan switches which resources
// appear on the canvas, and "remove from this plan" simply drops the pin
// from this array without touching the underlying resource row.
type FloorPlan struct {
	ID        string          `json:"ID"`
	TenantID  string          `json:"TenantID"`
	Name      string          `json:"Name"`
	Shapes    json.RawMessage `json:"Shapes"`
	Pins      json.RawMessage `json:"Pins"`
	IsDefault bool            `json:"IsDefault"`
	CreatedAt time.Time       `json:"CreatedAt"`
	UpdatedAt time.Time       `json:"UpdatedAt"`
}

// Repository is the persistence port for floor plans.
type Repository interface {
	List(ctx context.Context, tenantID string) ([]FloorPlan, error)
	GetByID(ctx context.Context, tenantID, id string) (*FloorPlan, error)
	Create(ctx context.Context, p FloorPlan) (FloorPlan, error)
	Update(ctx context.Context, p FloorPlan) (FloorPlan, error)
	Delete(ctx context.Context, tenantID, id string) error
	// Duplicate copies an existing plan's shapes into a new row under
	// `newName`. Returns the new plan. The new row is never the default.
	Duplicate(ctx context.Context, tenantID, sourceID, newName string) (FloorPlan, error)
	// SetDefault makes `id` the single default plan for the tenant.
	SetDefault(ctx context.Context, tenantID, id string) error
}
