package postgres

import (
	"context"

	"fsd-mrbs/src/domain/approval"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ApprovalRepo struct{ db *pgxpool.Pool }

func NewApprovalRepo(db *pgxpool.Pool) *ApprovalRepo { return &ApprovalRepo{db: db} }

func (r *ApprovalRepo) Save(ctx context.Context, a approval.Approval) error {
	_, err := r.db.Exec(ctx,
		`INSERT INTO approvals (id, tenant_id, booking_id, approver_id, decision, reason, decided_at)
         VALUES ($1, $2, $3, NULLIF($4,'')::uuid, $5, $6, $7)`,
		a.ID, a.TenantID, a.BookingID, a.ApproverID, a.Decision, a.Reason, a.DecidedAt)
	return err
}

func (r *ApprovalRepo) ListByBooking(ctx context.Context, bookingID string) ([]approval.Approval, error) {
	rows, err := r.db.Query(ctx,
		`SELECT id, tenant_id, booking_id, COALESCE(approver_id::text,''), decision, COALESCE(reason,''), decided_at
         FROM approvals WHERE booking_id = $1 ORDER BY decided_at DESC`, bookingID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanApprovals(rows)
}

func (r *ApprovalRepo) ListByTenant(ctx context.Context, tenantID string, limit int) ([]approval.Approval, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := r.db.Query(ctx,
		`SELECT id, tenant_id, booking_id, COALESCE(approver_id::text,''), decision, COALESCE(reason,''), decided_at
         FROM approvals WHERE tenant_id = $1 ORDER BY decided_at DESC LIMIT $2`, tenantID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanApprovals(rows)
}

func scanApprovals(rows pgxRows) ([]approval.Approval, error) {
	var out []approval.Approval
	for rows.Next() {
		var a approval.Approval
		if err := rows.Scan(&a.ID, &a.TenantID, &a.BookingID, &a.ApproverID, &a.Decision, &a.Reason, &a.DecidedAt); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, nil
}

// pgxRows captures the small subset of pgx.Rows we use here.
type pgxRows interface {
	Next() bool
	Scan(...interface{}) error
}
