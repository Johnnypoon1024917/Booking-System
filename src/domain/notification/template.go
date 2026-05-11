package notification

import (
	"context"
	"time"
)

// Template type constants define the supported notification template categories.
// Per R11: Email Notifications - the system sends confirmations, cancellations,
// and reminders to users, with per-tenant customizable templates.
const (
	// TemplateTypeConfirmation is sent when a booking is confirmed.
	TemplateTypeConfirmation = "confirmation"
	// TemplateTypeCancellation is sent when a booking is cancelled.
	TemplateTypeCancellation = "cancellation"
	// TemplateTypeReminder is sent as a reminder before a scheduled booking.
	TemplateTypeReminder = "reminder"
)

// NotificationTemplate represents a per-tenant email template used when sending
// booking-related notifications. The BodyTemplate field supports variable
// substitution (e.g., {{.UserName}}, {{.BookingTime}}) so tenants can brand
// and customize the content of confirmations, cancellations, and reminders.
//
// Per R11: Email Notifications.
type NotificationTemplate struct {
	ID           string    // Unique identifier (UUID)
	TenantID     string    // Tenant identifier for multi-tenant isolation
	TemplateType string    // One of: 'confirmation', 'cancellation', 'reminder'
	Subject      string    // Email subject line (may contain template variables)
	BodyTemplate string    // Email body supporting variable substitution
	CreatedAt    time.Time // Record creation timestamp
}

// Repository defines the contract for notification template persistence
type Repository interface {
	GetByTenantAndType(ctx context.Context, tenantID, templateType string) (*NotificationTemplate, error)
	ListByTenant(ctx context.Context, tenantID string) ([]NotificationTemplate, error)
	Save(ctx context.Context, template NotificationTemplate) error
	Delete(ctx context.Context, id string) error
}

// IsValidTemplateType reports whether the given template type is one of the
// supported notification template types.
func IsValidTemplateType(t string) bool {
	switch t {
	case TemplateTypeConfirmation, TemplateTypeCancellation, TemplateTypeReminder:
		return true
	default:
		return false
	}
}
