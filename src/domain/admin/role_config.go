package admin

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// RoleConfig represents a role-based access control configuration
// It defines permissions, booking limits, and custom role settings per tenant
type RoleConfig struct {
	ID           uuid.UUID              `json:"id"`
	TenantID     uuid.UUID              `json:"tenant_id"`
	RoleName     string                 `json:"role_name"`
	BookingLimit int                    `json:"booking_limit"`
	Permissions  map[string]interface{} `json:"permissions"`
	IsCustom     bool                   `json:"is_custom"`
	CreatedAt    time.Time              `json:"created_at"`
}

// Repository defines the contract for role config persistence
type RoleConfigRepository interface {
	GetByID(ctx context.Context, id uuid.UUID) (*RoleConfig, error)
	GetByTenantAndName(ctx context.Context, tenantID uuid.UUID, roleName string) (*RoleConfig, error)
	ListByTenant(ctx context.Context, tenantID uuid.UUID) ([]RoleConfig, error)
	Save(ctx context.Context, config RoleConfig) error
	Delete(ctx context.Context, id uuid.UUID) error
}

// NewRoleConfig creates a new role configuration with default values
func NewRoleConfig(tenantID uuid.UUID, roleName string) *RoleConfig {
	return &RoleConfig{
		ID:           uuid.New(),
		TenantID:     tenantID,
		RoleName:     roleName,
		BookingLimit: 10, // default booking limit
		Permissions:  make(map[string]interface{}),
		IsCustom:     false,
		CreatedAt:    time.Now(),
	}
}

// HasPermission checks if the role has a specific permission
func (r *RoleConfig) HasPermission(permission string) bool {
	if val, ok := r.Permissions[permission]; ok {
		return val == true
	}
	return false
}

// SetPermission sets a specific permission for the role
func (r *RoleConfig) SetPermission(permission string, value bool) {
	if r.Permissions == nil {
		r.Permissions = make(map[string]interface{})
	}
	r.Permissions[permission] = value
}
