package audit

import (
	"context"
	"time"
)

// Action types for audit entries (R18 - Audit Trail)
const (
	ActionBookingCreated   = "BOOKING_CREATED"
	ActionBookingModified  = "BOOKING_MODIFIED"
	ActionBookingCancelled = "BOOKING_CANCELLED"
	ActionBookingStatusChange = "BOOKING_STATUS_CHANGE"
	ActionRoleChanged      = "ROLE_CHANGED"
	ActionResourceConfigChange = "RESOURCE_CONFIG_CHANGE"
	ActionAdminAction      = "ADMIN_ACTION"
)

// Target entities for audit entries (R18 - Audit Trail)
const (
	TargetEntityBooking  = "booking"
	TargetEntityUser     = "user"
	TargetEntityResource = "resource"
)

// AuditEntry represents an audit trail entry for system actions.
// It provides a complete audit trail for compliance and incident investigation (R18 - Audit Trail).
type AuditEntry struct {
	ID            string                 // Unique identifier (UUID)
	TenantID      string                 // Tenant identifier for multi-tenant isolation
	Timestamp     time.Time              // When the action occurred
	ActorUserID   string                 // User who performed the action (empty for system actions)
	ActionType    string                 // Type of action: BOOKING_CREATED, ROLE_CHANGED, etc.
	TargetEntity  string                 // Entity type: booking, user, resource
	TargetID      string                 // ID of the affected entity
	PreviousState map[string]interface{} // State before the action (nil for creation events)
	NewState      map[string]interface{} // State after the action (nil for deletion events)
	IPAddress     string                 // IP address of the actor
	UserAgent     string                 // User agent string of the actor's client
}

// Repository defines the contract for audit entry persistence
type Repository interface {
	Save(ctx context.Context, entry AuditEntry) error
	FindByID(ctx context.Context, id string) (AuditEntry, error)
	FindByTenant(ctx context.Context, tenantID string, filters AuditFilter) ([]AuditEntry, error)
}

// AuditFilter defines filtering options for audit trail queries
type AuditFilter struct {
	StartDate    *time.Time // Filter entries from this date
	EndDate      *time.Time // Filter entries until this date
	ActorUserID  string     // Filter by actor user ID
	ActionType   string     // Filter by action type
	TargetEntity string     // Filter by target entity type
	TargetID     string     // Filter by target entity ID
	Limit        int        // Maximum number of entries to return
	Offset       int        // Offset for pagination
}
