package postgres

import (
	"context"
	"fmt"
	"os"
	"strings"

	"fsd-mrbs/src/domain/report"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ReportRepo struct {
	db *pgxpool.Pool
}

func NewReportRepo(db *pgxpool.Pool) *ReportRepo {
	return &ReportRepo{db: db}
}

// reportTZ returns the IANA timezone the report queries should localise
// times into. bookings.start_time is `timestamp without time zone` with
// UTC clock values (pgx writes the UTC components of a time.Time on
// insert), so TO_CHAR on the raw column prints UTC — wrong for any
// non-UTC user. Apply `AT TIME ZONE 'UTC' AT TIME ZONE reportTZ()` in
// every formatter that touches start_time / end_time.
//
// REPORT_TIMEZONE overrides the default; operators set it per
// deployment. Asia/Hong_Kong matches the FSD launch market.
func reportTZ() string {
	if tz := strings.TrimSpace(os.Getenv("REPORT_TIMEZONE")); tz != "" {
		return tz
	}
	return "Asia/Hong_Kong"
}

// fmtTime returns a SQL snippet that formats a timestamp-without-tz
// column as HH24:MI in the report timezone. Drop straight into a
// SELECT list. Reusing the helper means schema changes that swap to
// TIMESTAMPTZ only touch one line.
func fmtTime(col string) string {
	return fmt.Sprintf("TO_CHAR(%s AT TIME ZONE 'UTC' AT TIME ZONE '%s', 'HH24:MI')", col, reportTZ())
}

// fmtDate returns a SQL snippet that formats a timestamp as YYYY-MM-DD
// in the report timezone — the date boundary itself shifts under TZ
// conversion (a UTC 23:00 in May = HKT 07:00 next day), so this matters
// even for columns that look like "just dates".
func fmtDate(col string) string {
	return fmt.Sprintf("TO_CHAR(%s AT TIME ZONE 'UTC' AT TIME ZONE '%s', 'YYYY-MM-DD')", col, reportTZ())
}

// fmtDateTime combines the two for "YYYY-MM-DD HH24:MI".
func fmtDateTime(col string) string {
	return fmt.Sprintf("TO_CHAR(%s AT TIME ZONE 'UTC' AT TIME ZONE '%s', 'YYYY-MM-DD HH24:MI')", col, reportTZ())
}

func (r *ReportRepo) GetUsageData(ctx context.Context, startDate, endDate string) ([]report.UsageReportItem, error) {
	query := `
		SELECT 
			res.name as resource_name,
			COUNT(b.id) as total_bookings,
			COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_time - b.start_time))/3600), 0) as total_hours
		FROM resources res
		LEFT JOIN bookings b ON res.id = b.resource_id 
			AND b.start_time >= $1 AND b.end_time <= $2
			AND b.status IN ('Confirmed', 'Checked In')
		GROUP BY res.id, res.name
		ORDER BY total_hours DESC;
	`
	rows, err := r.db.Query(ctx, query, startDate, endDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []report.UsageReportItem
	for rows.Next() {
		var item report.UsageReportItem
		// Note: PeakTime calculation logic omitted for scaffolding brevity
		if err := rows.Scan(&item.ResourceName, &item.TotalBookings, &item.TotalHours); err == nil {
			item.PeakTime = "14:00 - 16:00" // Simulated peak time
			results = append(results, item)
		}
	}
	return results, nil
}

func (r *ReportRepo) GetNoShowData(ctx context.Context, startDate, endDate string) ([]report.NoShowReportItem, error) {
	query := fmt.Sprintf(`
		SELECT b.user_id, res.name, %s, b.status
		FROM bookings b
		JOIN resources res ON b.resource_id = res.id
		WHERE b.status = 'No Show'
		AND b.start_time >= $1 AND b.end_time <= $2
	`, fmtDate("b.start_time"))
	rows, err := r.db.Query(ctx, query, startDate, endDate)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var results []report.NoShowReportItem
	for rows.Next() {
		var item report.NoShowReportItem
		if err := rows.Scan(&item.UserID, &item.ResourceName, &item.Date, &item.Status); err == nil {
			results = append(results, item)
		}
	}
	return results, nil
}

// GetDashboard computes every panel on the FSD dashboard (p.9) in four
// tenant-scoped aggregate queries.
func (r *ReportRepo) GetDashboard(ctx context.Context, tenantID, start, end string, filter report.DashboardFilter) (report.DashboardData, error) {
	out := report.DashboardData{
		RoomUtilisation: []report.NameCount{},
		ByDepartment:    []report.NameCount{},
		NoShow:          []report.NoShowRow{},
		Scope:           string(filter.Scope),
	}

	// Build the scope WHERE clause + extra args once. Every panel below
	// appends the same clause so totals stay consistent.
	//   mine   → AND b.user_id = $4         (General User dashboard)
	//   region → AND res.region = ANY($4)   (Room Admin dashboard)
	//   all    → no extra clause            (System / Security Admin)
	scopeClause := ""
	var scopeArgs []any
	switch filter.Scope {
	case report.DashboardScopeMine:
		if filter.UserID != "" {
			scopeClause = " AND b.user_id = $4"
			scopeArgs = append(scopeArgs, filter.UserID)
		}
	case report.DashboardScopeRegion:
		if len(filter.Regions) > 0 {
			scopeClause = " AND res.region = ANY($4)"
			scopeArgs = append(scopeArgs, filter.Regions)
		}
	}
	args := append([]any{tenantID, start, end}, scopeArgs...)

	// 1) Room utilisation — bookings per room (excluding cancelled).
	rows, err := r.db.Query(ctx, `
		SELECT res.name, COUNT(b.id)
		FROM bookings b JOIN resources res ON res.id = b.resource_id
		WHERE b.tenant_id = $1 AND b.status <> 'Cancelled'
		  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
		  `+scopeClause+`
		GROUP BY res.name ORDER BY COUNT(b.id) DESC LIMIT 14`, args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var nc report.NameCount
		if rows.Scan(&nc.Name, &nc.Count) == nil {
			out.RoomUtilisation = append(out.RoomUtilisation, nc)
		}
	}
	rows.Close()

	// 2) Utilisation by department/region.
	rows, err = r.db.Query(ctx, `
		SELECT COALESCE(NULLIF(res.region,''),'Unassigned'), COUNT(b.id)
		FROM bookings b JOIN resources res ON res.id = b.resource_id
		WHERE b.tenant_id = $1 AND b.status <> 'Cancelled'
		  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
		  `+scopeClause+`
		GROUP BY 1 ORDER BY COUNT(b.id) DESC`, args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var nc report.NameCount
		if rows.Scan(&nc.Name, &nc.Count) == nil {
			out.ByDepartment = append(out.ByDepartment, nc)
		}
	}
	rows.Close()

	// 3) Statistics panel. The query joins resources unconditionally so
	// the region clause can apply; the join is cheap (FK index) and lets
	// one query serve all three scopes.
	// Walk-in: a booking whose creation time is within 5 minutes of its
	// start_time. These are "I showed up at the room, opened the SPA,
	// booked it" patterns — the opposite of pre-planned meetings. The
	// idx_bookings_walkin index added in migration 030 keeps this fast
	// even on large datasets.
	err = r.db.QueryRow(ctx, `
		SELECT
		  COUNT(*),
		  COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (b.end_time - b.start_time))/60)),0),
		  COUNT(*) FILTER (WHERE b.status = 'Checked In' OR b.checked_in_at IS NOT NULL),
		  COUNT(*) FILTER (WHERE b.status = 'Cancelled'),
		  COUNT(*) FILTER (WHERE b.status = 'No Show'),
		  COUNT(*) FILTER (WHERE EXTRACT(HOUR FROM b.start_time) < 9 OR EXTRACT(HOUR FROM b.start_time) >= 18),
		  COUNT(*) FILTER (WHERE b.start_time - b.created_at <= INTERVAL '5 minutes')
		FROM bookings b JOIN resources res ON res.id = b.resource_id
		WHERE b.tenant_id = $1 AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
		  `+scopeClause, args...).
		Scan(&out.Stats.Total, &out.Stats.AvgMin, &out.Stats.CheckInPct,
			&out.Stats.CancelPct, &out.Stats.NoShowPct, &out.Stats.NonOfficePct,
			&out.Stats.WalkInPct)
	if err != nil {
		return out, err
	}
	if out.Stats.Total > 0 {
		t := float64(out.Stats.Total)
		pct := func(n int) int { return int((float64(n) / t) * 100.0) }
		out.Stats.CheckInPct = pct(out.Stats.CheckInPct)
		out.Stats.CancelPct = pct(out.Stats.CancelPct)
		out.Stats.NoShowPct = pct(out.Stats.NoShowPct)
		out.Stats.NonOfficePct = pct(out.Stats.NonOfficePct)
		out.Stats.WalkInPct = pct(out.Stats.WalkInPct)
	} else {
		out.Stats.CheckInPct, out.Stats.CancelPct, out.Stats.NoShowPct, out.Stats.NonOfficePct, out.Stats.WalkInPct = 0, 0, 0, 0, 0
	}

	// 4) No Show table — same scope rules.
	rows, err = r.db.Query(ctx, fmt.Sprintf(`
		SELECT u.username, COALESCE(NULLIF(res.region,''),'-'), res.name,
		       %s
		FROM bookings b
		JOIN resources res ON res.id = b.resource_id
		JOIN users u ON u.id = b.user_id
		WHERE b.tenant_id = $1 AND b.status = 'No Show'
		  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
		  `+scopeClause+`
		ORDER BY b.start_time DESC LIMIT 12`, fmtDateTime("b.start_time")), args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var ns report.NoShowRow
		if rows.Scan(&ns.Name, &ns.Dept, &ns.Room, &ns.When) == nil {
			out.NoShow = append(out.NoShow, ns)
		}
	}
	rows.Close()

	return out, nil
}

// GetReportTable returns the rows for one of the FSD report types as a
// generic headers+rows table so a single endpoint serves them all.
func (r *ReportRepo) GetReportTable(ctx context.Context, tenantID, reportType, start, end string) (report.ReportTable, error) {
	t := report.ReportTable{Rows: [][]string{}}

	var query string
	switch reportType {
	case "audit":
		t.Headers = []string{"Date", "User", "Action", "Target", "Target ID"}
		query = fmt.Sprintf(`
			SELECT %s,
			       COALESCE(u.username,'system'), a.action_type, a.target_entity,
			       COALESCE(a.target_id::text,'')
			FROM audit_entries a LEFT JOIN users u ON u.id = a.actor_user_id
			WHERE a.tenant_id = $1
			  AND a.timestamp::date >= $2::date AND a.timestamp::date <= $3::date
			ORDER BY a.timestamp DESC LIMIT 1000`, fmtDateTime("a.timestamp"))
	case "staff":
		t.Headers = []string{"Booked By", "Bookings", "Total Hours"}
		query = `
			SELECT u.username, COUNT(b.id)::text,
			       TO_CHAR(COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_time-b.start_time))/3600),0),'FM999990.0')
			FROM bookings b JOIN users u ON u.id = b.user_id
			WHERE b.tenant_id = $1 AND b.status <> 'Cancelled'
			  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
			GROUP BY u.username ORDER BY COUNT(b.id) DESC LIMIT 1000`
	case "usage":
		t.Headers = []string{"Room", "Location", "Bookings", "Total Hours"}
		query = `
			SELECT res.name, res.location, COUNT(b.id)::text,
			       TO_CHAR(COALESCE(SUM(EXTRACT(EPOCH FROM (b.end_time-b.start_time))/3600),0),'FM999990.0')
			FROM bookings b JOIN resources res ON res.id = b.resource_id
			WHERE b.tenant_id = $1 AND b.status <> 'Cancelled'
			  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
			GROUP BY res.name, res.location ORDER BY COUNT(b.id) DESC LIMIT 1000`
	case "addl":
		t.Headers = []string{"Booking Date", "Room", "Booked By", "Status"}
		query = fmt.Sprintf(`
			SELECT %s, res.name, u.username, b.status
			FROM bookings b
			JOIN resources res ON res.id = b.resource_id
			JOIN users u ON u.id = b.user_id
			WHERE b.tenant_id = $1
			  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
			ORDER BY b.start_time DESC LIMIT 1000`, fmtDate("b.start_time"))
	case "noshow":
		t.Headers = []string{"Booking Date", "Time", "Location", "Room", "Booked By"}
		query = fmt.Sprintf(`
			SELECT %s, %s,
			       res.location, res.name, u.username
			FROM bookings b
			JOIN resources res ON res.id = b.resource_id
			JOIN users u ON u.id = b.user_id
			WHERE b.tenant_id = $1 AND b.status = 'No Show'
			  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date
			ORDER BY b.start_time DESC LIMIT 1000`, fmtDate("b.start_time"), fmtTime("b.start_time"))
	default: // "summary", "medical", and any unknown → booking summary
		// Title (the meeting subject) was missing from the summary export, so
		// every row read the same Date/Room/Status with no way to tell what
		// the booking was for (QA #9). Surface it between Room and Booked By.
		t.Headers = []string{"Booking Date", "Time", "Location", "Room", "Title", "Booked By", "Status"}
		query = fmt.Sprintf(`
			SELECT %s, %s,
			       res.location, res.name, COALESCE(NULLIF(b.title, ''), '—'), u.username, b.status
			FROM bookings b
			JOIN resources res ON res.id = b.resource_id
			JOIN users u ON u.id = b.user_id
			WHERE b.tenant_id = $1
			  AND b.start_time::date >= $2::date AND b.start_time::date <= $3::date`, fmtDate("b.start_time"), fmtTime("b.start_time"))
		query += `
			ORDER BY b.start_time DESC LIMIT 1000`
	}

	rows, err := r.db.Query(ctx, query, tenantID, start, end)
	if err != nil {
		return t, fmt.Errorf("report %q: %w", reportType, err)
	}
	defer rows.Close()
	ncols := len(t.Headers)
	for rows.Next() {
		cells := make([]string, ncols)
		ptrs := make([]any, ncols)
		for i := range cells {
			ptrs[i] = &cells[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			continue
		}
		for i := range cells {
			cells[i] = strings.TrimSpace(cells[i])
		}
		t.Rows = append(t.Rows, cells)
	}
	return t, nil
}
