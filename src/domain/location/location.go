// Package location models a first-class, admin-managed Location (a tower,
// floor, station, etc.). Resources reference a Location by name; the
// Organisation Hierarchy and the resource editor's Location dropdown are
// driven from this list instead of free-text strings.
package location

import (
	"context"
	"time"
)

type Location struct {
	ID        string    `json:"ID"`
	TenantID  string    `json:"TenantID"`
	Name      string    `json:"Name"`
	Region    string    `json:"Region"`
	CreatedAt time.Time `json:"CreatedAt"`
	UpdatedAt time.Time `json:"UpdatedAt"`
}

type Repository interface {
	List(ctx context.Context, tenantID string) ([]Location, error)
	Create(ctx context.Context, l Location) (Location, error)
	Update(ctx context.Context, l Location) (Location, error)
	Delete(ctx context.Context, tenantID, id string) error
}
