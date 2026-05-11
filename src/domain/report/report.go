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

type ReportRepository interface {
	GetUsageData(ctx context.Context, startDate, endDate string) ([]UsageReportItem, error)
	GetNoShowData(ctx context.Context, startDate, endDate string) ([]NoShowReportItem, error)
}
