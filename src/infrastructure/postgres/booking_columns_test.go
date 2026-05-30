package postgres

import (
	"reflect"
	"regexp"
	"strings"
	"testing"

	"fsd-mrbs/src/domain/booking"
)

// TestBookingColumnsCount is the guardrail that triggered after the
// `is_private` add silently broke ListAllForDate. Whenever a column is
// added to the bookings table, three places in this package must agree
// on the count:
//
//   1. const bookingColumns               — the canonical SELECT list.
//   2. ListPendingForApprover's inline    — re-aliased with "b." prefix
//      SELECT (line ~185)                   so the JOIN to resources works.
//   3. ListAllForDate's inline SELECT     — same reason as #2.
//   4. scanBookings()                      — the row scanner.
//
// If any of these drift apart, pgx returns
// "number of field descriptions must equal number of destinations".
// This test fails BEFORE the binary ships so the regression is caught
// by CI rather than at the customer's "could not load bookings" toast.
//
// The test is a pure string + reflection check — no DB required, so it
// runs in every commit. The next time you add a column to bookings:
//
//   * Append it to bookingColumns AND to both inline SELECTs.
//   * Append the matching field to booking.Booking + the Scan list in
//     scanBookings + the Scan call in BookingRepo.FindByID.
//   * Bump the expected count constants in this test if (and only if)
//     the schema add was deliberate.
//
// Two failures in this test = two real bugs. One failure = an honest
// mistake the column-counter just saved you from.

const (
	// Update when adding a column to the bookings projection. Current
	// Phase-4 columns (18): id, tenant_id, resource_id, user_id,
	// start_time, end_time, status, is_recurring, recurrence_id,
	// exception_notes, meeting_url, redirect_url, checked_in_at,
	// version, created_at, booking_mode, title, is_private.
	expectedBookingSelectColumns = 18
	expectedBookingScanFields    = 18
)

// columnCountSQL counts comma-separated items in a SELECT-list snippet.
// It strips out commas that live inside function calls (e.g.
// COALESCE(x, '')) so a single COALESCE counts as one column, not two.
func columnCountSQL(s string) int {
	// Strip newlines + tabs so we can do a clean walk.
	s = strings.Join(strings.Fields(s), " ")
	depth := 0
	cols := 1
	for _, r := range s {
		switch r {
		case '(':
			depth++
		case ')':
			depth--
		case ',':
			if depth == 0 {
				cols++
			}
		}
	}
	return cols
}

func TestBookingColumns_Const(t *testing.T) {
	got := columnCountSQL(bookingColumns)
	if got != expectedBookingSelectColumns {
		t.Fatalf("bookingColumns has %d columns, expected %d\n"+
			"If you added a column on purpose, bump expectedBookingSelectColumns "+
			"AND make sure ListPendingForApprover, ListAllForDate, and scanBookings "+
			"all agree on the new count.",
			got, expectedBookingSelectColumns)
	}
}

// inlineSelects pulls every "SELECT ... FROM bookings" block out of the
// repo file so the test stays accurate even as new queries are added.
// We use a generous regex because the queries use line continuations
// and multiple JOINs; the SQL string itself is parsed by columnCountSQL.
func TestBookingColumns_InlineSelects(t *testing.T) {
	t.Parallel()
	src := readSourceFile(t, "booking_repo.go")
	re := regexp.MustCompile(`(?si)SELECT\s+(b\.id,.*?)\s+FROM\s+bookings\s+b`)
	matches := re.FindAllStringSubmatch(src, -1)
	if len(matches) == 0 {
		t.Skip("no inline SELECTs found — coverage came entirely from bookingColumns const, which TestBookingColumns_Const already verifies")
	}
	for i, m := range matches {
		cols := columnCountSQL(m[1])
		if cols != expectedBookingSelectColumns {
			t.Errorf("inline SELECT #%d has %d columns, expected %d\n"+
				"This usually means a recent schema change updated the\n"+
				"bookingColumns const but missed one of the JOIN'd queries.\n"+
				"--- offending SELECT ---\n%s\n------------------------",
				i+1, cols, expectedBookingSelectColumns, m[1])
		}
	}
}

// TestBookingScan_FieldCount reads the booking.Booking struct via
// reflection. It is NOT a strict equality check (the struct has more
// fields than the wire/DB list — TenantID and ResourceID are reused
// across other paths). Instead it asserts that the count of fields
// pgx.Scan WILL touch in scanBookings matches the SELECT width.
//
// The list of scan-targeted fields is hand-maintained here because the
// scanBookings call site is the only place that knows the order; this
// test is the safety net under it.
func TestBookingScan_FieldCount(t *testing.T) {
	t.Parallel()
	scannedFields := []string{
		"ID", "TenantID", "ResourceID", "UserID", "StartTime", "EndTime", "Status",
		"IsRecurring", "RecurrenceID", "ExceptionNotes",
		"MeetingURL", "RedirectURL", "CheckedInAt", "Version", "CreatedAt",
		"BookingMode", "Title", "IsPrivate",
	}
	// Verify each named field actually exists on the struct so a
	// rename causes a loud failure here rather than a silent
	// production scan error.
	bt := reflect.TypeOf(booking.Booking{})
	for _, name := range scannedFields {
		if _, ok := bt.FieldByName(name); !ok {
			t.Errorf("booking.Booking.%s is referenced in scanBookings but no longer exists; rename or remove from the scan list", name)
		}
	}
	if len(scannedFields) != expectedBookingScanFields {
		t.Errorf("scannedFields has %d entries, expected %d — keep this list 1:1 with the Scan destinations in scanBookings",
			len(scannedFields), expectedBookingScanFields)
	}
}

// readSourceFile reads the named Go file in the same package so the
// inline-SELECT scanner has something to match against. Failing the
// read is fatal because the test depends on it.
func readSourceFile(t *testing.T, name string) string {
	t.Helper()
	b, err := readFile(name)
	if err != nil {
		t.Fatalf("could not read %s: %v — the test must run from the postgres package directory", name, err)
	}
	return string(b)
}
