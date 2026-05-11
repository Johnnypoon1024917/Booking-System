package postgres

import (
	"context"
	"time"

	"fsd-mrbs/src/domain/approval"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ApprovalStepRepo struct{ db *pgxpool.Pool }

func NewApprovalStepRepo(db *pgxpool.Pool) *ApprovalStepRepo { return &ApprovalStepRepo{db: db} }

func (r *ApprovalStepRepo) Save(ctx context.Context, s approval.Step) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO approval_steps (id, tenant_id, booking_id, rule_id, step_index, level_name,
    approver_ids, approver_role, min_grade, status, due_at)
VALUES ($1, $2, $3, NULLIF($4,'')::uuid, $5, $6, $7::uuid[], NULLIF($8,''), NULLIF($9,''), $10, $11)
ON CONFLICT (booking_id, step_index) DO NOTHING`,
		s.ID, s.TenantID, s.BookingID, s.RuleID, s.StepIndex, s.LevelName,
		s.ApproverIDs, s.ApproverRole, s.MinGrade, s.Status, s.DueAt)
	return err
}

func (r *ApprovalStepRepo) UpdateDecision(ctx context.Context, id, status, decidedBy, reason string, when time.Time) error {
	_, err := r.db.Exec(ctx, `
UPDATE approval_steps
   SET status = $2, decided_by = NULLIF($3,'')::uuid, reason = $4, decision_at = $5
 WHERE id = $1`, id, status, decidedBy, reason, when)
	return err
}

func (r *ApprovalStepRepo) ListByBooking(ctx context.Context, bookingID string) ([]approval.Step, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, tenant_id, booking_id, COALESCE(rule_id::text,''), step_index, level_name,
       approver_ids, COALESCE(approver_role,''), COALESCE(min_grade,''),
       status, COALESCE(decided_by::text,''), decision_at, COALESCE(reason,''), due_at, created_at
FROM approval_steps WHERE booking_id = $1 ORDER BY step_index`, bookingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSteps(rows)
}

func (r *ApprovalStepRepo) ListPending(ctx context.Context, tenantID string) ([]approval.Step, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, tenant_id, booking_id, COALESCE(rule_id::text,''), step_index, level_name,
       approver_ids, COALESCE(approver_role,''), COALESCE(min_grade,''),
       status, COALESCE(decided_by::text,''), decision_at, COALESCE(reason,''), due_at, created_at
FROM approval_steps WHERE tenant_id = $1 AND status = 'pending'
ORDER BY created_at`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanSteps(rows)
}

func scanSteps(rows pgxRows) ([]approval.Step, error) {
	var out []approval.Step
	for rows.Next() {
		var s approval.Step
		var approverIDs []string
		var decisionAt *time.Time
		var dueAt *time.Time
		err := rows.Scan(&s.ID, &s.TenantID, &s.BookingID, &s.RuleID, &s.StepIndex, &s.LevelName,
			&approverIDs, &s.ApproverRole, &s.MinGrade,
			&s.Status, &s.DecidedBy, &decisionAt, &s.Reason, &dueAt, &s.CreatedAt)
		if err != nil {
			return nil, err
		}
		s.ApproverIDs = approverIDs
		s.DecisionAt = decisionAt
		s.DueAt = dueAt
		out = append(out, s)
	}
	return out, nil
}
