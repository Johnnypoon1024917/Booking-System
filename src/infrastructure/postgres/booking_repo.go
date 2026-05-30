package postgres

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/infrastructure/dbctx"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BookingRepo is the canonical reads-and-writes adapter for the bookings
// table. Every method runs through dbctx.ExecutorFromContext so a request
// wrapped by middleware.WithTenantTx executes inside the per-request
// transaction (where the RLS policy on bookings can see
// app.current_tenant_id). Unwrapped callers — workers, scheduler,
// background jobs — fall through to the bare pool.
type BookingRepo struct {
	db *pgxpool.Pool
}

func NewBookingRepository(db *pgxpool.Pool) *BookingRepo {
	return &BookingRepo{db: db}
}

// exec resolves the active executor: pinned tx when present, pool otherwise.
func (r *BookingRepo) exec(ctx context.Context) dbctx.Executor {
	return dbctx.ExecutorFromContext(ctx, r.db)
}

const bookingColumns = `id, tenant_id, resource_id, user_id, start_time, end_time, status,
    is_recurring, COALESCE(recurrence_id::text,''), COALESCE(exception_notes,''),
    COALESCE(meeting_url,''), COALESCE(redirect_url,''), checked_in_at, version, created_at,
    COALESCE(booking_mode, 'exclusive'), COALESCE(title,''), COALESCE(is_private, FALSE)`

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
	err := r.exec(ctx).QueryRow(ctx, query, resourceID, start, end).Scan(&conflict)
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
	err := r.exec(ctx).QueryRow(ctx, query, tenantID, resourceID, start, end).Scan(&conflict)
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
    is_recurring, recurrence_id, exception_notes, meeting_url, redirect_url, checked_in_at, version, created_at, booking_mode, title, is_private)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF($9,'')::uuid, $10, $11, $12, $13, 1, $14, $16, NULLIF($17,''), $18)
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
    title           = EXCLUDED.title,
    is_private      = EXCLUDED.is_private,
    version         = bookings.version + 1
WHERE bookings.version = $15`

	cmdTag, err := r.exec(ctx).Exec(ctx, query,
		b.ID, b.TenantID, b.ResourceID, b.UserID, b.StartTime, b.EndTime, b.Status,
		b.IsRecurring, b.RecurrenceID, b.ExceptionNotes, b.MeetingURL, b.RedirectURL, b.CheckedInAt,
		b.CreatedAt, b.Version, mode, b.Title, b.IsPrivate)
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
	_, err := r.exec(ctx).Exec(ctx,
		`UPDATE bookings SET status = $2, exception_notes = COALESCE(NULLIF($3,''), exception_notes) WHERE id = $1`,
		id, status, notes)
	return err
}

// Cancel sets status='Cancelled'. The EXCLUDE constraint filters by status
// so the slot is freed for new bookings on the next conflict check.
func (r *BookingRepo) Cancel(ctx context.Context, id, reason string) error {
	return r.UpdateStatus(ctx, id, booking.StatusCancelled, reason)
}

func (r *BookingRepo) FindByID(ctx context.Context, id string) (booking.Booking, error) {
	var b booking.Booking
	var checkedInAt *time.Time
	err := r.exec(ctx).QueryRow(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE id = $1`, id,
	).Scan(
		&b.ID, &b.TenantID, &b.ResourceID, &b.UserID, &b.StartTime, &b.EndTime, &b.Status,
		&b.IsRecurring, &b.RecurrenceID, &b.ExceptionNotes, &b.MeetingURL, &b.RedirectURL, &checkedInAt,
		&b.Version, &b.CreatedAt, &b.BookingMode, &b.Title, &b.IsPrivate)
	b.CheckedInAt = checkedInAt
	return b, err
}

func (r *BookingRepo) ListByUser(ctx context.Context, userID string) ([]booking.Booking, error) {
	rows, err := r.exec(ctx).Query(ctx,
		`SELECT `+bookingColumns+` FROM bookings WHERE user_id = $1 ORDER BY start_time DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

func (r *BookingRepo) ListByResource(ctx context.Context, resourceID string) ([]booking.Booking, error) {
	rows, err := r.exec(ctx).Query(ctx,
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
       b.checked_in_at, b.version, b.created_at, COALESCE(b.booking_mode,'exclusive'),
       COALESCE(b.title,''), COALESCE(b.is_private, FALSE)
FROM bookings b
JOIN resources r ON r.id = b.resource_id
WHERE b.tenant_id = $1
  AND b.status = 'Pending Approval'
  AND ($2::uuid = ANY(r.approver_ids) OR r.approver_ids = '{}' OR r.approver_ids IS NULL)
ORDER BY b.start_time ASC`
	rows, err := r.exec(ctx).Query(ctx, query, tenantID, approverID)
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
	rows, err := r.exec(ctx).Query(ctx, query, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

// ListAllForDate returns all bookings for a given date (or all upcoming if no date).
// Used by admin timetable view. Delegates to ListAllForRange.
func (r *BookingRepo) ListAllForDate(ctx context.Context, tenantID, date string, regionAccess []string) ([]booking.Booking, error) {
	return r.ListAllForRange(ctx, tenantID, date, date, regionAccess)
}

// ListAllForRange returns bookings with start_time inside [start..end]
// inclusive, where start/end are YYYY-MM-DD strings. Pass the same
// string twice for a single-day query, or both empty for "everything
// from the past 7 days onwards" (the legacy unfiltered ListAllForDate
// behaviour). The fragmented Week/Month calendar views call this with
// the visible-period boundaries so a meeting on Friday actually shows
// up when the user is looking at the week containing it.
func (r *BookingRepo) ListAllForRange(ctx context.Context, tenantID, start, end string, regionAccess []string) ([]booking.Booking, error) {
	var query string
	var args []interface{}

	baseQuery := `
SELECT b.id, b.tenant_id, b.resource_id, b.user_id, b.start_time, b.end_time, b.status,
    b.is_recurring, COALESCE(b.recurrence_id::text,''), COALESCE(b.exception_notes,''),
    COALESCE(b.meeting_url,''), COALESCE(b.redirect_url,''), b.checked_in_at, b.version, b.created_at,
    COALESCE(b.booking_mode, 'exclusive'), COALESCE(b.title,''),
    COALESCE(b.is_private, FALSE)
FROM bookings b
JOIN resources res ON b.resource_id = res.id
WHERE b.tenant_id = $1
  AND (cardinality($2::text[]) = 0 OR res.region = ANY($2::text[]))`

	args = []interface{}{tenantID, regionAccess}

	switch {
	case start != "" && end != "":
		// Inclusive [start..end] — `< end::date + 1 day` so a booking
		// at 23:00 on `end` is still captured.
		query = baseQuery + `
  AND b.start_time >= $3::date
  AND b.start_time < ($4::date + INTERVAL '1 day')
ORDER BY b.start_time ASC`
		args = append(args, start, end)
	case start != "":
		query = baseQuery + `
  AND b.start_time >= $3::date
  AND b.start_time < ($3::date + INTERVAL '1 day')
ORDER BY b.start_time ASC`
		args = append(args, start)
	default:
		query = baseQuery + `
  AND b.end_time > NOW() - INTERVAL '7 days'
ORDER BY b.start_time ASC`
	}

	rows, err := r.exec(ctx).Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanBookings(rows)
}

// CountConcurrent reports how many active bookings overlap [start, end) on
// the given resource. Used by the use case to enforce shared_capacity for
// resources whose booking_mode == "shared". When excludeBookingID is
// non-empty that row is omitted, so an update doesn't count the booking
// being rescheduled against itself.
func (r *BookingRepo) CountConcurrent(ctx context.Context, resourceID string, start, end time.Time, excludeBookingID string) (int, error) {
	var n int
	err := r.exec(ctx).QueryRow(ctx, `
SELECT COUNT(1) FROM bookings
 WHERE resource_id = $1
   AND status IN ('Confirmed', 'Pending Approval', 'Checked In')
   AND start_time < $3 AND end_time > $2
   AND ($4 = '' OR id::text <> $4)`,
		resourceID, start, end, excludeBookingID).Scan(&n)
	return n, err
}

// LockResourceForUpdate takes a row-level FOR UPDATE lock on the resource
// row. Inside the per-request transaction (middleware.WithTenantTx) the lock
// is held until commit, serializing the capacity-check + insert for shared
// resources against concurrent bookings — closing the TOCTOU window where two
// requests both read count = cap-1 and both succeed. Against the bare pool
// (background jobs) the implicit transaction commits immediately, so the lock
// is effectively a no-op; those callers don't race on shared capacity.
func (r *BookingRepo) LockResourceForUpdate(ctx context.Context, resourceID string) error {
	_, err := r.exec(ctx).Exec(ctx,
		`SELECT 1 FROM resources WHERE id = $1::uuid FOR UPDATE`, resourceID)
	return err
}

// AddServiceToBooking links a service from the catalog to a booking.
func (r *BookingRepo) AddServiceToBooking(ctx context.Context, bookingID, serviceID string, quantity int, notes string) error {
	const query = `
INSERT INTO booking_services (booking_id, service_id, quantity, notes)
VALUES ($1, $2, $3, $4)
ON CONFLICT (booking_id, service_id) DO UPDATE
SET quantity = EXCLUDED.quantity,
    notes = EXCLUDED.notes`

	_, err := r.exec(ctx).Exec(ctx, query, bookingID, serviceID, quantity, notes)
	return err
}

func (r *BookingRepo) CountActiveByUser(ctx context.Context, userID string) (int, error) {
	var n int
	err := r.exec(ctx).QueryRow(ctx,
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
			&b.Version, &b.CreatedAt, &b.BookingMode, &b.Title, &b.IsPrivate)
		if err != nil {
			return nil, err
		}
		b.CheckedInAt = checkedInAt
		out = append(out, b)
	}
	return out, nil
}
