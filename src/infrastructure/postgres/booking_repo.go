package postgres

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/booking"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type BookingRepo struct {
	db *pgxpool.Pool
}

func NewBookingRepository(db *pgxpool.Pool) *BookingRepo {
	return &BookingRepo{db: db}
}

const bookingColumns = `id, tenant_id, resource_id, user_id, start_time, end_time, status,
    is_recurring, COALESCE(recurrence_id::text,''), COALESCE(exception_notes,''),
    COALESCE(meeting_url,''), COALESCE(redirect_url,''), checked_in_at, version, created_at,
    COALESCE(booking_mode, 'exclusive')`

// HasConflict checks for overlapping bookings, including parent/child
// composite resources. If the queried resource has children, all child
// bookings count. If the queried resource is itself a child, its parent's
// bookings count too. Siblings do NOT conflict.
func (r *BookingRepo) HasConflict(ctx context.Context, resourceID string, start, end time.Time) (bool, error) {
	const query = `
WITH targets AS (
  SELECT $1::uuid AS rid
  UNION
  SELECT id FROM resources WHERE parent_resource_id = $1::uuid
  UNION
  SELECT parent_resource_id FROM resources WHERE id = $1::uuid AND parent_resource_id IS NOT NULL
)
SELECT EXISTS (
  SELECT 1 FROM bookings b
   WHERE b.resource_id IN (SELECT rid FROM targets WHERE rid IS NOT NULL)
     AND b.status IN ('Confirmed', 'Pending Approval', 'Checked In')
     AND b.start_time < $3 AND b.end_time > $2
)`
	var conflict bool
	err := r.db.QueryRow(ctx, query, resourceID, start, end).Scan(&conflict)
	return conflict, err
}

func (r *BookingRepo) HasConflictTenant(ctx context.Context, tenantID, resourceID string, start, end time.Time) (bool, error) {
	const query = `
WITH targets AS (
  SELECT $2::uuid AS rid
  UNION
  SELECT id FROM resources WHERE tenant_id = $1::uuid AND parent_resource_id = $2::uuid
  UNION
  SELECT parent_resource_id FROM resources WHERE tenant_id = $1::uuid AND id = $2::uuid AND parent_resource_id IS NOT NULL
)
SELECT EXISTS (
  SELECT 1 FROM bookings b
   WHERE b.tenant_id = $1::uuid
     AND b.resource_id IN (SELECT rid FROM targets WHERE rid IS NOT NULL)
     AND b.status IN ('Confirmed', 'Pending Approval', 'Checked In')
     AND b.start_time < $4 AND b.end_time > $3
)`
	var conflict bool
	err := r.db.QueryRow(ctx, query, tenantID, resourceID, start, end).Scan(&conflict)
	return conflict, err
}

// Save inserts or updates a booking. The bookings_no_overlap EXCLUDE
// constraint at the DB level prevents two concurrent inserts from both
// succeeding for the same resource — translated into ErrConcurrencyConflict.
func (r *BookingRepo) Save(ctx context.Context, b booking.Booking) error {
	mode := b.BookingMode
	if mode == "" {
		mode = booking.BookingModeExclusive
	}
	const query = `
INSERT INTO bookings (id, tenant_id, resource_id, user_id, start_time, end_time, status,
    is_recurring, recurrence_id, exception_notes, meeting_url, redirect_url, checked_in_at, version, created_at, booking_mode)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9,'')::uuid, $10, $11, $12, $13, 1, $14, $16)
ON CONFLICT (id) DO UPDATE
SET status          = EXCLUDED.status,
    is_recurring    = EXCLUDED.is_recurring,
    recurrence_id   = EXCLUDED.recurrence_id,
    exception_notes = EXCLUDED.exception_notes,
    meeting_url     = EXCLUDED.meeting_url,
    redirect_url    = EXCLUDED.redirect_url,
    checked_in_at   = EXCLUDED.checked_in_at,
    start_time      = EXCLUDED.start_time,
    end_time        = EXCLUDED.end_time,
    version         = bookings.version + 1
WHERE bookings.version = $15`

	cmdTag, err := r.db.Exec(ctx, query,
		b.ID, b.TenantID, b.ResourceID, b.UserID, b.StartTime, b.EndTime, b.Status,
		b.IsRecurring, b.RecurrenceID, b.ExceptionNotes, b.MeetingURL, b.RedirectURL, b.CheckedInAt,
		b.CreatedAt, b.Version, mode)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			if pgErr.Code == "23P01" || strings.Contains(pgErr.ConstraintName, "no_overlap") {
				return booking.ErrConcurrencyConflict
			}
		}
		return err
	}
	if cmdTag.RowsAffected() == 0 {
		return booking.ErrConcurrencyConflict
	}
	return nil
}

// UpdateStatus is the cheap path for approve/reject/cancel — it doesn't
// re-run conflict detection or version checks because the only mutation
// is the status field itself.
func (r *BookingRepo) UpdateStatus(ctx context.Context, id, status, notes string) error {
	_, err := r.db.Exec(ctx,
		`UPDATE bookings SET status = $2, exception_notes = COALESCE(NULLIF($3,''), exception_notes) WHERE id = $1`,
		id, status, notes)
	return err
}

// Cancel sets status='Cancelled'. The EXCLUDE constraint filters by status
// so the slot is freed for new bookings on the next conflict check.
func (r *BookingRepo) Cancel(ctx context.Context, id, reason string) error {
	return r.UpdateStatus(ctx, id, "Cancelled", reason)
}

func (r *BookingRepo) FindByID(ctx context.Context, id string) (booking.Booking, error) {
	var b booking.Booking
	var checkedInAt *time.Time
	err := r.db.QueryRow(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE id = $1`, id,
	).Scan(
		&b.ID, &b.TenantID, &b.ResourceID, &b.UserID, &b.StartTime, &b.EndTime, &b.Status,
		&b.IsRecurring, &b.RecurrenceID, &b.ExceptionNotes, &b.MeetingURL, &b.RedirectURL, &checkedInAt,
		&b.Version, &b.CreatedAt, &b.BookingMode)
	b.CheckedInAt = checkedInAt
	return b, err
}

func (r *BookingRepo) ListByUser(ctx context.Context, userID string) ([]booking.Booking, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE user_id = $1 ORDER BY start_time DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

func (r *BookingRepo) ListByResource(ctx context.Context, resourceID string) ([]booking.Booking, error) {
	rows, err := r.db.Query(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE resource_id = $1 ORDER BY start_time DESC`, resourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

// ListPendingForApprover returns bookings awaiting approval where the
// given user is in the resource's approver_ids array. Used by the
// /api/v1/approvals inbox.
func (r *BookingRepo) ListPendingForApprover(ctx context.Context, tenantID, approverID string) ([]booking.Booking, error) {
	const query = `
SELECT b.id, b.tenant_id, b.resource_id, b.user_id, b.start_time, b.end_time, b.status,
       b.is_recurring, COALESCE(b.recurrence_id::text,''), COALESCE(b.exception_notes,''),
       COALESCE(b.meeting_url,''), COALESCE(b.redirect_url,''),
       b.checked_in_at, b.version, b.created_at, COALESCE(b.booking_mode,'exclusive')
FROM bookings b
JOIN resources r ON r.id = b.resource_id
WHERE b.tenant_id = $1
  AND b.status = 'Pending Approval'
  AND ($2::uuid = ANY(r.approver_ids) OR r.approver_ids = '{}' OR r.approver_ids IS NULL)
ORDER BY b.start_time ASC`
	rows, err := r.db.Query(ctx, query, tenantID, approverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

// ListByUserUpcoming returns the user's upcoming + recent bookings. Used
// by the My Bookings page.
func (r *BookingRepo) ListByUserUpcoming(ctx context.Context, userID string) ([]booking.Booking, error) {
	const query = `
SELECT ` + bookingColumns + `
FROM bookings
WHERE user_id = $1
  AND end_time > NOW() - INTERVAL '7 days'
ORDER BY start_time ASC`
	rows, err := r.db.Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

// CountConcurrent reports how many active bookings overlap [start, end) on
// the given resource. Used by the use case to enforce shared_capacity for
// resources whose booking_mode == "shared".
func (r *BookingRepo) CountConcurrent(ctx context.Context, resourceID string, start, end time.Time) (int, error) {
	var n int
	err := r.db.QueryRow(ctx, `
SELECT COUNT(1) FROM bookings
 WHERE resource_id = $1
   AND status IN ('Confirmed', 'Pending Approval', 'Checked In')
   AND start_time < $3 AND end_time > $2`,
		resourceID, start, end).Scan(&n)
	return n, err
}

func (r *BookingRepo) CountActiveByUser(ctx context.Context, userID string) (int, error) {
	var n int
	err := r.db.QueryRow(ctx,
		`SELECT COUNT(1) FROM bookings WHERE user_id = $1
         AND status IN ('Confirmed', 'Pending Approval', 'Checked In')`, userID,
	).Scan(&n)
	return n, err
}

func scanBookings(rows pgxRows) ([]booking.Booking, error) {
	var out []booking.Booking
	for rows.Next() {
		var b booking.Booking
		var checkedInAt *time.Time
		err := rows.Scan(
			&b.ID, &b.TenantID, &b.ResourceID, &b.UserID, &b.StartTime, &b.EndTime, &b.Status,
			&b.IsRecurring, &b.RecurrenceID, &b.ExceptionNotes, &b.MeetingURL, &b.RedirectURL, &checkedInAt,
			&b.Version, &b.CreatedAt, &b.BookingMode)
		if err != nil {
			return nil, err
		}
		b.CheckedInAt = checkedInAt
		out = append(out, b)
	}
	return out, nil
}
