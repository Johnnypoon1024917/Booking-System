// The scheduler binary runs the recurring background jobs:
//
//   - auto-release no-show every minute
//   - HKO weather poll every 5 minutes (suspends/resumes no-show penalties)
//   - gov.hk holiday import nightly at 02:00 HKT
//
// It's deliberately a thin "tick driver": each job is a use case implemented
// in src/application/usecase, so the same code can run from a unit test or
// a one-shot CLI.
package main

import (
	"context"
	"log"
	"os"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/infrastructure/external"
	infraint "fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dbURL := os.Getenv("DB_DSN")
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer pool.Close()

	hko := external.NewHKOClient(0)
	holidayClient := external.NewGovHKHolidayClient(0)

	// Graph subscription lifecycle manager (only useful when at least
	// one tenant has Microsoft credentials configured + GRAPH_NOTIFY_URL
	// set). The use case skips silently when no rows are due.
	subMgrUC := usecase.NewManageGraphSubscriptionsUseCase(
		postgres.NewIntegrationCredentialRepo(pool),
		postgres.NewRoomMailboxRepo(pool),
		postgres.NewGraphSubscriptionRepo(pool),
		infraint.NewGraphClient(0),
		os.Getenv("GRAPH_NOTIFY_URL"),
	)

	autoRelease := time.NewTicker(60 * time.Second)
	weather := time.NewTicker(5 * time.Minute)
	graphSubs := time.NewTicker(60 * time.Minute)
	holidays := dailyAt(2, 0) // 02:00 HKT
	defer autoRelease.Stop()
	defer weather.Stop()
	defer graphSubs.Stop()

	log.Println("scheduler ready")
	for {
		select {
		case <-ctx.Done():
			return
		case <-autoRelease.C:
			tickAutoRelease(ctx, pool)
		case <-weather.C:
			tickWeather(ctx, hko, pool)
		case <-graphSubs.C:
			tickGraphSubscriptionRenewal(ctx, subMgrUC)
		case <-holidays:
			tickHolidays(ctx, holidayClient, pool)
		}
	}
}

// tickGraphSubscriptionRenewal extends any Graph subscription within 12
// hours of expiry. We renew well before the 70.5h ceiling so a single
// failed renewal cycle has plenty of room to recover.
func tickGraphSubscriptionRenewal(ctx context.Context, uc *usecase.ManageGraphSubscriptionsUseCase) {
	n, err := uc.RenewExpiring(ctx)
	if err != nil {
		log.Printf("graph subscription renewal: %v", err)
		return
	}
	if n > 0 {
		log.Printf("graph subscription renewal: refreshed %d", n)
	}
}

func tickAutoRelease(ctx context.Context, pool *pgxpool.Pool) {
	// Inline SQL keeps the scheduler honest about what it does.
	// In a tenant-aware system we'd loop over tenants and read each
	// tenant's grace period from customization_config; for now we use
	// a sensible default.
	cutoff := time.Now().Add(-15 * time.Minute)
	tag, err := pool.Exec(ctx, `
		UPDATE bookings
		   SET status = 'No Show'
		 WHERE status = 'Confirmed'
		   AND checked_in_at IS NULL
		   AND start_time < $1
	`, cutoff)
	if err != nil {
		log.Printf("auto-release: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("auto-release: flipped %d bookings to No Show", n)
	}
}

func tickWeather(ctx context.Context, c *external.HKOClient, pool *pgxpool.Pool) {
	signals, err := c.CurrentSignals(ctx)
	if err != nil {
		log.Printf("hko: %v", err)
		return
	}
	suspending := ""
	for _, s := range signals {
		if s.SuspendsBookings() {
			suspending = s.Code
			break
		}
	}
	if suspending == "" {
		return
	}
	tag, err := pool.Exec(ctx, `
		UPDATE bookings
		   SET status = 'Exception',
		       exception_notes = $1
		 WHERE status IN ('Confirmed', 'No Show')
		   AND start_time::date = CURRENT_DATE
	`, "Auto: HKO "+suspending)
	if err != nil {
		log.Printf("weather mark: %v", err)
		return
	}
	if n := tag.RowsAffected(); n > 0 {
		log.Printf("weather %s suspended %d bookings", suspending, n)
	}
}

func tickHolidays(ctx context.Context, c *external.GovHKHolidayClient, pool *pgxpool.Pool) {
	holidays, err := c.Fetch(ctx, "en")
	if err != nil {
		log.Printf("gov.hk holidays: %v", err)
		return
	}
	inserted := 0
	for _, h := range holidays {
		_, err := pool.Exec(ctx, `
			INSERT INTO holidays (id, tenant_id, holiday_date, description, is_blocker, created_by)
			SELECT gen_random_uuid(), t.id, $1, $2, TRUE, 'system'
			  FROM tenants t
			 WHERE NOT EXISTS (
			       SELECT 1 FROM holidays h
			        WHERE h.tenant_id = t.id AND h.holiday_date = $1
			 )
		`, h.Date, h.Description)
		if err != nil {
			log.Printf("holiday upsert %s: %v", h.Date.Format("2006-01-02"), err)
			continue
		}
		inserted++
	}
	if inserted > 0 {
		log.Printf("gov.hk: imported %d holidays", inserted)
	}
}

// dailyAt returns a channel that fires once per day at the given local
// hour:minute. Time arithmetic uses time.Local so it tracks DST.
func dailyAt(hour, minute int) <-chan time.Time {
	ch := make(chan time.Time, 1)
	go func() {
		for {
			now := time.Now()
			next := time.Date(now.Year(), now.Month(), now.Day(), hour, minute, 0, 0, time.Local)
			if !next.After(now) {
				next = next.Add(24 * time.Hour)
			}
			time.Sleep(time.Until(next))
			ch <- time.Now()
		}
	}()
	return ch
}
