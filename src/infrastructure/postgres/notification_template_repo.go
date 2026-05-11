package postgres

import (
	"context"
	"fmt"

	"fsd-mrbs/src/domain/notification"

	"github.com/jackc/pgx/v5/pgxpool"
)

// notificationTemplateRepo implements notification.Repository using PostgreSQL
type notificationTemplateRepo struct {
	db *pgxpool.Pool
}

// NewNotificationTemplateRepository creates a new notification template repository instance
func NewNotificationTemplateRepository(db *pgxpool.Pool) notification.Repository {
	return &notificationTemplateRepo{db: db}
}

// GetByTenantAndType retrieves a notification template by tenant ID and template type
func (r *notificationTemplateRepo) GetByTenantAndType(ctx context.Context, tenantID, templateType string) (*notification.NotificationTemplate, error) {
	query := `
		SELECT id, tenant_id, template_type, subject, body_template, created_at
		FROM notification_templates
		WHERE tenant_id = $1 AND template_type = $2
	`

	var template notification.NotificationTemplate
	err := r.db.QueryRow(ctx, query, tenantID, templateType).Scan(
		&template.ID,
		&template.TenantID,
		&template.TemplateType,
		&template.Subject,
		&template.BodyTemplate,
		&template.CreatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("failed to get notification template by tenant and type: %w", err)
	}

	return &template, nil
}

// ListByTenant retrieves all notification templates for a tenant
func (r *notificationTemplateRepo) ListByTenant(ctx context.Context, tenantID string) ([]notification.NotificationTemplate, error) {
	query := `
		SELECT id, tenant_id, template_type, subject, body_template, created_at
		FROM notification_templates
		WHERE tenant_id = $1
		ORDER BY template_type
	`

	rows, err := r.db.Query(ctx, query, tenantID)
	if err != nil {
		return nil, fmt.Errorf("failed to list notification templates: %w", err)
	}
	defer rows.Close()

	var templates []notification.NotificationTemplate
	for rows.Next() {
		var template notification.NotificationTemplate
		err := rows.Scan(
			&template.ID,
			&template.TenantID,
			&template.TemplateType,
			&template.Subject,
			&template.BodyTemplate,
			&template.CreatedAt,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan notification template: %w", err)
		}
		templates = append(templates, template)
	}

	return templates, nil
}

// Save creates or updates a notification template
func (r *notificationTemplateRepo) Save(ctx context.Context, template notification.NotificationTemplate) error {
	query := `
		INSERT INTO notification_templates (id, tenant_id, template_type, subject, body_template, created_at)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE
		SET template_type = EXCLUDED.template_type,
			subject = EXCLUDED.subject,
			body_template = EXCLUDED.body_template
	`

	_, err := r.db.Exec(ctx, query,
		template.ID,
		template.TenantID,
		template.TemplateType,
		template.Subject,
		template.BodyTemplate,
		template.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("failed to save notification template: %w", err)
	}
	return nil
}

// Delete removes a notification template by ID
func (r *notificationTemplateRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM notification_templates WHERE id = $1`
	_, err := r.db.Exec(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete notification template: %w", err)
	}
	return nil
}
