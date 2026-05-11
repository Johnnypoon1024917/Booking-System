package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"fsd-mrbs/src/domain/approval"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ApprovalRuleRepo struct{ db *pgxpool.Pool }

func NewApprovalRuleRepo(db *pgxpool.Pool) *ApprovalRuleRepo { return &ApprovalRuleRepo{db: db} }

func (r *ApprovalRuleRepo) List(ctx context.Context, tenantID string) ([]approval.Rule, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, tenant_id, name, scope_type, COALESCE(scope_value,''), priority, levels, is_active, created_at, updated_at
FROM approval_rules WHERE tenant_id = $1 ORDER BY priority, name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []approval.Rule
	for rows.Next() {
		ru, err := scanRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, ru)
	}
	return out, nil
}

func (r *ApprovalRuleRepo) Get(ctx context.Context, id string) (*approval.Rule, error) {
	row := r.db.QueryRow(ctx, `
SELECT id, tenant_id, name, scope_type, COALESCE(scope_value,''), priority, levels, is_active, created_at, updated_at
FROM approval_rules WHERE id = $1`, id)
	ru, err := scanRule(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("approval rule not found")
	}
	if err != nil {
		return nil, err
	}
	return &ru, nil
}

func (r *ApprovalRuleRepo) Save(ctx context.Context, ru approval.Rule) error {
	levelsJSON, err := json.Marshal(ru.Levels)
	if err != nil {
		return err
	}
	_, err = r.db.Exec(ctx, `
INSERT INTO approval_rules (id, tenant_id, name, scope_type, scope_value, priority, levels, is_active)
VALUES ($1, $2, $3, $4, NULLIF($5,''), $6, $7::jsonb, $8)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    scope_type = EXCLUDED.scope_type,
    scope_value = EXCLUDED.scope_value,
    priority = EXCLUDED.priority,
    levels = EXCLUDED.levels,
    is_active = EXCLUDED.is_active,
    updated_at = NOW()
`, ru.ID, ru.TenantID, ru.Name, ru.ScopeType, ru.ScopeValue, ru.Priority, levelsJSON, ru.IsActive)
	return err
}

func (r *ApprovalRuleRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM approval_rules WHERE id = $1`, id)
	return err
}

type rowLike interface {
	Scan(...interface{}) error
}

func scanRule(row rowLike) (approval.Rule, error) {
	var ru approval.Rule
	var levelsJSON []byte
	if err := row.Scan(&ru.ID, &ru.TenantID, &ru.Name, &ru.ScopeType, &ru.ScopeValue,
		&ru.Priority, &levelsJSON, &ru.IsActive, &ru.CreatedAt, &ru.UpdatedAt); err != nil {
		return ru, err
	}
	if len(levelsJSON) > 0 {
		_ = json.Unmarshal(levelsJSON, &ru.Levels)
	}
	return ru, nil
}
