package audit

import (
	"context"
	"time"
)

// Action types for audit entries (R18 - Audit Trail / NIST AU-2).
const (
	ActionBookingCreated       = "BOOKING_CREATED"
	ActionBookingModified      = "BOOKING_MODIFIED"
	ActionBookingCancelled     = "BOOKING_CANCELLED"
	ActionBookingStatusChange  = "BOOKING_STATUS_CHANGE"
	ActionRoleChanged          = "ROLE_CHANGED"
	ActionPermissionChanged    = "PERMISSION_CHANGED"
	ActionResourceConfigChange = "RESOURCE_CONFIG_CHANGE"
	ActionAdminAction          = "ADMIN_ACTION"
	ActionLoginSuccess         = "LOGIN_SUCCESS"
	ActionLoginFailure         = "LOGIN_FAILURE"
	ActionLogout               = "LOGOUT"
	ActionTokenIssued          = "TOKEN_ISSUED"
	ActionSCIMTokenIssued      = "SCIM_TOKEN_ISSUED"
	ActionSCIMTokenRevoked     = "SCIM_TOKEN_REVOKED"
	ActionSecretAccessed       = "SECRET_ACCESSED"
	ActionWebhookCreated       = "WEBHOOK_CREATED"
	ActionWebhookDeleted       = "WEBHOOK_DELETED"
	ActionDataExported         = "DATA_EXPORTED"
	// Admin user-management actions. UserUpdated covers field-level
	// edits (DN, region, grade, departments); a Role change always
	// also emits ActionRoleChanged at SeverityCritical so SOC can
	// alert on privilege escalations specifically.
	ActionUserCreated     = "USER_CREATED"
	ActionUserUpdated     = "USER_UPDATED"
	ActionUserDeactivated = "USER_DEACTIVATED"
)

// Outcomes (NIST AU-3 requires success/failure recording).
const (
	OutcomeSuccess = "success"
	OutcomeFailure = "failure"
	OutcomeDenied  = "denied"
)

// Severity levels for SIEM routing.
const (
	SeverityInfo     = "info"
	SeverityWarning  = "warning"
	SeverityCritical = "critical"
)

// Target entities for audit entries (R18 - Audit Trail)
const (
	TargetEntityBooking  = "booking"
	TargetEntityUser     = "user"
	TargetEntityResource = "resource"
)

// AuditEntry represents an audit trail entry for system actions.
// It provides a complete audit trail for compliance and incident investigation
// (R18 - Audit Trail / NIST 800-53 AU-2, AU-3, AU-9).
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
	Outcome       string                 // OutcomeSuccess | OutcomeFailure | OutcomeDenied
	Severity      string                 // SeverityInfo | SeverityWarning | SeverityCritical
	SessionID     string                 // Token jti or session identifier (correlate sessions)
	RequestID     string                 // Per-request correlation id from logging middleware
	PrevHash      string                 // hex SHA-256 of the previous entry's EntryHash (chain)
	EntryHash     string                 // hex SHA-256 over canonical payload + PrevHash
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
