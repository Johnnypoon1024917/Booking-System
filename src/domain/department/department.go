// Package department models organisational units inside a tenant. Resources
// can be grouped under a department for rollup reporting and routing of
// approvals (e.g. Operations vs. Training vs. Senior Management).
package department

import (
	"context"
	"time"
)

type Department struct {
	ID        string
	TenantID  string
	Name      string
	Code      string
	ParentID  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type Repository interface {
	List(ctx context.Context, tenantID string) ([]Department, error)
	GetByID(ctx context.Context, id string) (*Department, error)
	Save(ctx context.Context, d Department) error
	Delete(ctx context.Context, id string) error
}
