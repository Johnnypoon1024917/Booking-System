package report

import "context"

// UsageReportItem tracks duration, peak times, and utilisation rates.
type UsageReportItem struct {
	ResourceName  string
	TotalBookings int
	TotalHours    float64
	PeakTime      string
}

// NoShowReportItem breaks down missed bookings by DPID or specific units.
type NoShowReportItem struct {
	UserID       string
	ResourceName string
	Date         string
	Status       string
}

// NameCount is a generic label→count pair used by the dashboard charts
// (room utilisation bars, utilisation-by-department pie).
type NameCount struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// NoShowRow is one row of the dashboard No Show table.
type NoShowRow struct {
	Name string `json:"name"`
	Dept string `json:"dept"`
	Room string `json:"room"`
	When string `json:"when"`
}

// Stats is the dashboard "Statistics" panel (FSD spec p.9).
type Stats struct {
	Total        int `json:"total"`
	AvgMin       int `json:"avgMin"`
	CheckInPct   int `json:"checkInPct"`
	CancelPct    int `json:"cancelPct"`
	NoShowPct    int `json:"noShowPct"`
	WalkInPct    int `json:"walkInPct"`
	NonOfficePct int `json:"nonOfficePct"`
}

// DashboardData is the full payload behind GET /api/v1/reports/dashboard.
type DashboardData struct {
	RoomUtilisation []NameCount `json:"roomUtilisation"`
	ByDepartment    []NameCount `json:"byDepartment"`
	Stats           Stats       `json:"stats"`
	NoShow          []NoShowRow `json:"noShow"`
	// Scope labels the slice of data shown — "mine" (own bookings only),
	// "region" (rooms the user manages), or "all" (tenant-wide).
	// The SPA uses this to show a banner like "My Bookings" vs "All Rooms".
	Scope string `json:"scope"`
}

// DashboardScope enumerates how a dashboard request should be aggregated.
type DashboardScope string

const (
	DashboardScopeMine   DashboardScope = "mine"
	DashboardScopeRegion DashboardScope = "region"
	DashboardScopeAll    DashboardScope = "all"
)

// DashboardFilter narrows the dashboard query to one user, one set of
// regions, or the whole tenant. Repository implementations apply WHERE
// clauses accordingly. When Scope is "all" the UserID and Regions fields
// are ignored.
type DashboardFilter struct {
	Scope   DashboardScope
	UserID  string
	Regions []string
}

// ReportTable is a generic tabular report (headers + string rows) so a
// single endpoint can serve every report type the FSD deck lists
// (Audit Trail, Booking Summary, No Show, Daily Staff Productivity,
// Room Usage and Duration, Medical, Additional).
type ReportTable struct {
	Headers []string   `json:"headers"`
	Rows    [][]string `json:"rows"`
}

type ReportRepository interface {
	GetUsageData(ctx context.Context, startDate, endDate string) ([]UsageReportItem, error)
	GetNoShowData(ctx context.Context, startDate, endDate string) ([]NoShowReportItem, error)
	GetDashboard(ctx context.Context, tenantID, startDate, endDate string, filter DashboardFilter) (DashboardData, error)
	GetReportTable(ctx context.Context, tenantID, reportType, startDate, endDate string) (ReportTable, error)
}
