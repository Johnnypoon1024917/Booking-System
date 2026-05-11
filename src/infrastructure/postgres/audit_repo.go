package postgres

import (
	"context"
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/audit"

	"github.com/jackc/pgx/v5/pgxpool"
)

// auditRepo implements audit.Repository using PostgreSQL
type auditRepo struct {
	db *pgxpool.Pool
}

// NewAuditRepository creates a new audit repository instance
func NewAuditRepository(db *pgxpool.Pool) audit.Repository {
	return &auditRepo{db: db}
}

// Save creates a new audit entry
func (r *auditRepo) Save(ctx context.Context, entry audit.AuditEntry) error {
	previousStateJSON, _ := json.Marshal(entry.PreviousState)
	newStateJSON, _ := json.Marshal(entry.NewState)

	query := `
		INSERT INTO audit_entries (id, tenant_id, timestamp, actor_user_id, action_type,
			target_entity, target_id, previous_state, new_state, ip_address, user_agent)
		VALUES ($1, $2, $3, NULLIF($4,'')::uuid, $5, $6, $7, $8, $9, $10, $11)
	`

	_, err := r.db.Exec(ctx, query,
		entry.ID,
		entry.TenantID,
		entry.Timestamp,
		entry.ActorUserID,
		entry.ActionType,
		entry.TargetEntity,
		entry.TargetID,
		previousStateJSON,
		newStateJSON,
		entry.IPAddress,
		entry.UserAgent,
	)
	if err != nil {
		return fmt.Errorf("failed to save audit entry: %w", err)
	}
	return nil
}

// FindByID retrieves an audit entry by its ID
func (r *auditRepo) FindByID(ctx context.Context, id string) (audit.AuditEntry, error) {
	query := `
		SELECT id, tenant_id, timestamp, COALESCE(actor_user_id::text,''), action_type, target_entity, target_id,
			previous_state, new_state, ip_address, user_agent
		FROM audit_entries
		WHERE id = $1
	`

	var entry audit.AuditEntry
	var previousStateJSON, newStateJSON []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&entry.ID,
		&entry.TenantID,
		&entry.Timestamp,
		&entry.ActorUserID,
		&entry.ActionType,
		&entry.TargetEntity,
		&entry.TargetID,
		&previousStateJSON,
		&newStateJSON,
		&entry.IPAddress,
		&entry.UserAgent,
	)
	if err != nil {
		return audit.AuditEntry{}, fmt.Errorf("failed to find audit entry by id: %w", err)
	}

	// Unmarshal JSONB fields
	if len(previousStateJSON) > 0 && string(previousStateJSON) != "null" {
		json.Unmarshal(previousStateJSON, &entry.PreviousState)
	}
	if len(newStateJSON) > 0 && string(newStateJSON) != "null" {
		json.Unmarshal(newStateJSON, &entry.NewState)
	}

	return entry, nil
}

// FindByTenant retrieves audit entries for a tenant with filtering
func (r *auditRepo) FindByTenant(ctx context.Context, tenantID string, filters audit.AuditFilter) ([]audit.AuditEntry, error) {
	query := `
		SELECT id, tenant_id, timestamp, COALESCE(actor_user_id::text,''), action_type, target_entity, target_id,
			previous_state, new_state, ip_address, user_agent
		FROM audit_entries
		WHERE tenant_id = $1
	`
	args := []interface{}{tenantID}
	argCount := 1

	// Apply filters dynamically
	if filters.StartDate != nil {
		argCount++
		query += fmt.Sprintf(" AND timestamp >= $%d", argCount)
		args = append(args, *filters.StartDate)
	}
	if filters.EndDate != nil {
		argCount++
		query += fmt.Sprintf(" AND timestamp <= $%d", argCount)
		args = append(args, *filters.EndDate)
	}
	if filters.ActorUserID != "" {
		argCount++
		query += fmt.Sprintf(" AND actor_user_id = $%d", argCount)
		args = append(args, filters.ActorUserID)
	}
	if filters.ActionType != "" {
		argCount++
		query += fmt.Sprintf(" AND action_type = $%d", argCount)
		args = append(args, filters.ActionType)
	}
	if filters.TargetEntity != "" {
		argCount++
		query += fmt.Sprintf(" AND target_entity = $%d", argCount)
		args = append(args, filters.TargetEntity)
	}
	if filters.TargetID != "" {
		argCount++
		query += fmt.Sprintf(" AND target_id = $%d", argCount)
		args = append(args, filters.TargetID)
	}

	query += " ORDER BY timestamp DESC"

	if filters.Limit > 0 {
		argCount++
		query += fmt.Sprintf(" LIMIT $%d", argCount)
		args = append(args, filters.Limit)
	}
	if filters.Offset > 0 {
		argCount++
		query += fmt.Sprintf(" OFFSET $%d", argCount)
		args = append(args, filters.Offset)
	}

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to find audit entries: %w", err)
	}
	defer rows.Close()

	var entries []audit.AuditEntry
	for rows.Next() {
		var entry audit.AuditEntry
		var previousStateJSON, newStateJSON []byte

		err := rows.Scan(
			&entry.ID,
			&entry.TenantID,
			&entry.Timestamp,
			&entry.ActorUserID,
			&entry.ActionType,
			&entry.TargetEntity,
			&entry.TargetID,
			&previousStateJSON,
			&newStateJSON,
			&entry.IPAddress,
			&entry.UserAgent,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan audit entry: %w", err)
		}

		// Unmarshal JSONB fields
		if len(previousStateJSON) > 0 && string(previousStateJSON) != "null" {
			json.Unmarshal(previousStateJSON, &entry.PreviousState)
		}
		if len(newStateJSON) > 0 && string(newStateJSON) != "null" {
			json.Unmarshal(newStateJSON, &entry.NewState)
		}

		entries = append(entries, entry)
	}

	return entries, nil
}
