package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"fsd-mrbs/src/domain/visitor"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5/pgxpool"
)

type visitorRepo struct {
	db *pgxpool.Pool
}

func NewVisitorRepository(db *pgxpool.Pool) visitor.Repository {
	return &visitorRepo{db: db}
}

func (r *visitorRepo) exec(ctx context.Context) dbctx.Executor {
	return dbctx.ExecutorFromContext(ctx, r.db)
}

const visitorColumns = `id, tenant_id,
	COALESCE(booking_id::text,''), host_user_id::text,
	visitor_name, COALESCE(visitor_email,''), COALESCE(visitor_phone,''),
	COALESCE(visitor_company,''), COALESCE(visitor_id_type,''),
	COALESCE(visitor_id_last4,''), COALESCE(purpose,''),
	expected_at, expected_until, status,
	checked_in_at, checked_out_at, health_declaration,
	nda_accepted, COALESCE(notes,''), COALESCE(token_hash,''),
	token_expires_at, COALESCE(created_by::text,''), created_at, updated_at`

func (r *visitorRepo) Save(ctx context.Context, v visitor.Visit) error {
	hd, _ := json.Marshal(v.HealthDeclaration)
	_, err := r.exec(ctx).Exec(ctx, `
INSERT INTO visits (
    id, tenant_id, booking_id, host_user_id,
    visitor_name, visitor_email, visitor_phone, visitor_company,
    visitor_id_type, visitor_id_last4, purpose,
    expected_at, expected_until, status,
    checked_in_at, checked_out_at, health_declaration,
    nda_accepted, notes, token_hash, token_expires_at,
    created_by, created_at, updated_at
) VALUES (
    $1, $2, NULLIF($3,'')::uuid, $4::uuid,
    $5, NULLIF($6,''), NULLIF($7,''), NULLIF($8,''),
    NULLIF($9,''), NULLIF($10,''), NULLIF($11,''),
    $12, $13, $14,
    $15, $16, $17::jsonb,
    $18, NULLIF($19,''), NULLIF($20,''), $21,
    NULLIF($22,'')::uuid, $23, $24
) ON CONFLICT (id) DO UPDATE
SET visitor_name = EXCLUDED.visitor_name,
    visitor_email = EXCLUDED.visitor_email,
    visitor_phone = EXCLUDED.visitor_phone,
    visitor_company = EXCLUDED.visitor_company,
    purpose = EXCLUDED.purpose,
    expected_at = EXCLUDED.expected_at,
    expected_until = EXCLUDED.expected_until,
    status = EXCLUDED.status,
    checked_in_at = EXCLUDED.checked_in_at,
    checked_out_at = EXCLUDED.checked_out_at,
    health_declaration = EXCLUDED.health_declaration,
    nda_accepted = EXCLUDED.nda_accepted,
    notes = EXCLUDED.notes,
    token_hash = EXCLUDED.token_hash,
    token_expires_at = EXCLUDED.token_expires_at,
    updated_at = NOW()`,
		v.ID, v.TenantID, v.BookingID, v.HostUserID,
		v.VisitorName, v.VisitorEmail, v.VisitorPhone, v.VisitorCompany,
		v.VisitorIDType, v.VisitorIDLast4, v.Purpose,
		v.ExpectedAt, v.ExpectedUntil, v.Status,
		v.CheckedInAt, v.CheckedOutAt, hd,
		v.NDAAccepted, v.Notes, v.TokenHash, v.TokenExpiresAt,
		v.CreatedBy, v.CreatedAt, v.UpdatedAt,
	)
	return err
}

func (r *visitorRepo) FindByID(ctx context.Context, tenantID, id string) (*visitor.Visit, error) {
	row := r.exec(ctx).QueryRow(ctx,
		`SELECT `+visitorColumns+` FROM visits WHERE id = $1 AND tenant_id = $2`,
		id, tenantID)
	return scanVisit(row)
}

func (r *visitorRepo) FindByTokenHash(ctx context.Context, tokenHash string) (*visitor.Visit, error) {
	row := r.exec(ctx).QueryRow(ctx,
		`SELECT `+visitorColumns+` FROM visits WHERE token_hash = $1`, tokenHash)
	return scanVisit(row)
}

func (r *visitorRepo) ListForHost(ctx context.Context, tenantID, hostUserID string, from, to time.Time) ([]visitor.Visit, error) {
	rows, err := r.exec(ctx).Query(ctx,
		`SELECT `+visitorColumns+`
FROM visits
WHERE tenant_id = $1 AND host_user_id = $2::uuid AND expected_at BETWEEN $3 AND $4
ORDER BY expected_at ASC`, tenantID, hostUserID, from, to)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVisits(rows)
}

func (r *visitorRepo) ListForTenant(ctx context.Context, tenantID string, from, to time.Time, status string) ([]visitor.Visit, error) {
	q := strings.Builder{}
	q.WriteString(`SELECT ` + visitorColumns + ` FROM visits
WHERE tenant_id = $1 AND expected_at BETWEEN $2 AND $3`)
	args := []interface{}{tenantID, from, to}
	if status != "" {
		q.WriteString(fmt.Sprintf(" AND status = $%d", len(args)+1))
		args = append(args, status)
	}
	q.WriteString(` ORDER BY expected_at ASC`)
	rows, err := r.exec(ctx).Query(ctx, q.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVisits(rows)
}

func (r *visitorRepo) UpdateStatus(ctx context.Context, tenantID, id, status string, at time.Time) error {
	var ts1, ts2 string
	switch status {
	case visitor.StatusCheckedIn:
		ts1 = "checked_in_at = $4,"
	case visitor.StatusCheckedOut:
		ts2 = "checked_out_at = $4,"
	}
	q := fmt.Sprintf(`UPDATE visits
SET status = $3, %s %s updated_at = NOW()
WHERE id = $1 AND tenant_id = $2`, ts1, ts2)
	_, err := r.exec(ctx).Exec(ctx, q, id, tenantID, status, at)
	return err
}

func scanVisit(row interface{ Scan(...interface{}) error }) (*visitor.Visit, error) {
	var v visitor.Visit
	var hdJSON []byte
	if err := row.Scan(
		&v.ID, &v.TenantID, &v.BookingID, &v.HostUserID,
		&v.VisitorName, &v.VisitorEmail, &v.VisitorPhone, &v.VisitorCompany,
		&v.VisitorIDType, &v.VisitorIDLast4, &v.Purpose,
		&v.ExpectedAt, &v.ExpectedUntil, &v.Status,
		&v.CheckedInAt, &v.CheckedOutAt, &hdJSON,
		&v.NDAAccepted, &v.Notes, &v.TokenHash,
		&v.TokenExpiresAt, &v.CreatedBy, &v.CreatedAt, &v.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if len(hdJSON) > 0 && string(hdJSON) != "null" {
		_ = json.Unmarshal(hdJSON, &v.HealthDeclaration)
	}
	return &v, nil
}

func scanVisits(rows pgxRows) ([]visitor.Visit, error) {
	var out []visitor.Visit
	for rows.Next() {
		v, err := scanVisit(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *v)
	}
	return out, nil
}
