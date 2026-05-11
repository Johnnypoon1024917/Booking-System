package postgres

import (
	"context"
	"fsd-mrbs/src/domain/report"

	"github.com/jackc/pgx/v5/pgxpool"
)

type ReportRepo struct {
	db *pgxpool.Pool
}

func NewReportRepo(db *pgxpool.Pool) *ReportRepo {
	return &ReportRepo{db: db}
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
	query := `
		SELECT b.user_id, res.name, TO_CHAR(b.start_time, 'YYYY-MM-DD'), b.status
		FROM bookings b
		JOIN resources res ON b.resource_id = res.id
		WHERE b.status = 'No Show' 
		AND b.start_time >= $1 AND b.end_time <= $2
	`
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
