package tenant

import "github.com/google/uuid"

// TenantStatus represents the operational status of a tenant
type TenantStatus string

const (
	StatusActive    TenantStatus = "active"
	StatusSuspended TenantStatus = "suspended"
	StatusDeleted   TenantStatus = "deleted"
)

// Tenant represents an isolated organizational instance within the multi-tenant platform
type Tenant struct {
	ID                   uuid.UUID
	Name                 string
	DisplayName          string
	Status               TenantStatus
	BrandingConfig       map[string]interface{}
	IdentityProviderConfig map[string]interface{}
	ApprovalConfig       map[string]interface{}
	BookingLimits        map[string]interface{}
}

// IsActive returns true if the tenant is operational
func (t *Tenant) IsActive() bool {
	return t.Status == StatusActive
}

// IsSuspended returns true if the tenant is suspended
func (t *Tenant) IsSuspended() bool {
	return t.Status == StatusSuspended
}

// IsDeleted returns true if the tenant is deleted
func (t *Tenant) IsDeleted() bool {
	return t.Status == StatusDeleted
}

// CanPerformOperations returns true if the tenant can perform booking operations
// Per R1.4: WHILE a Tenant is suspended, THE Booking_Engine SHALL reject all booking operations
func (t *Tenant) CanPerformOperations() bool {
	return t.IsActive()
}
