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
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/domain/tenant"
	"fsd-mrbs/src/infrastructure/external"
	infraint "fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/postgres"

	"github.com/jackc/pgx/v5/pgxpool"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Graceful shutdown so a SIGTERM during a tick lets the in-flight
	// query finish before the pool drains.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		s := <-stop
		log.Printf("scheduler: received %s, exiting", s)
		cancel()
	}()

	dbURL := os.Getenv("DB_DSN")
	if dbURL == "" {
		log.Fatal("DB_DSN is required")
	}
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
	retention := time.NewTicker(6 * time.Hour)
	holidays := dailyAt(2, 0) // 02:00 HKT
	auditCheck := dailyAt(3, 0) // 03:00 HKT — runs verify_audit_chain()
	defer autoRelease.Stop()
	defer weather.Stop()
	defer graphSubs.Stop()
	defer retention.Stop()

	log.Println("scheduler ready")
	// Run retention once at boot so a fresh deploy immediately tidies up.
	tickRetention(ctx, pool)
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
		case <-retention.C:
			tickRetention(ctx, pool)
		case <-holidays:
			tickHolidays(ctx, holidayClient, pool)
		case <-auditCheck:
			tickAuditChainVerify(ctx, pool)
		}
	}
}

// tickAuditChainVerify runs SELECT verify_audit_chain() and logs any
// tenant whose chain is broken at WARN level so SIEM rules can route
// the alert. A break implies someone wrote to audit_entries outside
// the audit_repo path — either accidental (a maintenance script) or
// adversarial (an attacker with DB access trying to hide a trace).
func tickAuditChainVerify(ctx context.Context, pool *pgxpool.Pool) {
	rows, err := pool.Query(ctx, "SELECT tenant_id, total_entries, broken_at_id, broken_at_timestamp, reason FROM verify_audit_chain()")
	if err != nil {
		log.Printf("audit-chain verify: %v", err)
		return
	}
	defer rows.Close()
	var tenants, broken int
	for rows.Next() {
		var (
			tenantID string
			total    int64
			brokenID *string
			brokenTS *time.Time
			reason   string
		)
		if err := rows.Scan(&tenantID, &total, &brokenID, &brokenTS, &reason); err != nil {
			continue
		}
		tenants++
		if reason != "ok" {
			broken++
			log.Printf("AUDIT CHAIN BROKEN tenant=%s entries=%d broken_at=%v reason=%s",
				tenantID, total, brokenID, reason)
		}
	}
	if broken > 0 {
		log.Printf("audit-chain verify: %d/%d tenants broken", broken, tenants)
	} else {
		log.Printf("audit-chain verify: %d tenants healthy", tenants)
	}
}

// tickRetention enforces storage-limitation rules across the operational
// tables. The cut-offs intentionally favour safety: idempotency keys are
// already expiry-stamped so we just sweep expired rows; bookings older
// than 365 days are archived into bookings_archive (created lazily if it
// does not exist yet); audit_entries are NEVER truncated — only summary
// reporting is offloaded. This pass satisfies GDPR Art. 5(1)(e), HK PDPO
// DPP2, and NIST SI-12.
func tickRetention(ctx context.Context, pool *pgxpool.Pool) {
	// 1. Expired idempotency keys.
	if tag, err := pool.Exec(ctx,
		`DELETE FROM idempotency_keys WHERE expires_at < NOW()`); err == nil {
		if n := tag.RowsAffected(); n > 0 {
			log.Printf("retention: pruned %d expired idempotency keys", n)
		}
	} else {
		log.Printf("retention: idempotency prune: %v", err)
	}
	// 2. Successfully-delivered webhook deliveries older than 30 days.
	if tag, err := pool.Exec(ctx, `
DELETE FROM webhook_deliveries
 WHERE delivered_at IS NOT NULL
   AND created_at < NOW() - INTERVAL '30 days'`); err == nil {
		if n := tag.RowsAffected(); n > 0 {
			log.Printf("retention: pruned %d delivered webhooks", n)
		}
	} else {
		log.Printf("retention: webhook prune: %v", err)
	}
	// 3. Cancelled or No-Show bookings older than 365 days are moved
	//    into the archive table for cold storage. Audit entries remain
	//    untouched so investigators can still reconstruct the timeline.
	if _, err := pool.Exec(ctx, `
CREATE TABLE IF NOT EXISTS bookings_archive (LIKE bookings INCLUDING ALL);`); err != nil {
		log.Printf("retention: archive ensure: %v", err)
		return
	}
	if tag, err := pool.Exec(ctx, `
WITH moved AS (
    DELETE FROM bookings
    WHERE status IN ('Cancelled', 'No Show')
      AND end_time < NOW() - INTERVAL '365 days'
    RETURNING *
)
INSERT INTO bookings_archive SELECT * FROM moved`); err == nil {
		if n := tag.RowsAffected(); n > 0 {
			log.Printf("retention: archived %d old cancelled/no-show bookings", n)
		}
	} else {
		log.Printf("retention: booking archive: %v", err)
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

// tickAutoRelease marks Confirmed-but-not-checked-in bookings as "No
// Show" once they're past their start time + grace period. The slot
// then becomes available for re-booking because the EXCLUDE constraint
// only blocks Confirmed/Pending/Checked-In rows.
//
// Two env knobs:
//
//   AUTO_RELEASE_DISABLED=true    completely disables the sweep. Useful
//                                 for demos / dev so freshly-booked slots
//                                 don't disappear after 15 min.
//   AUTO_RELEASE_GRACE_MINUTES=N  grace period after start_time before a
//                                 booking is considered "abandoned".
//                                 Default 60 (was 15 — too aggressive for
//                                 manual testing and conference-room use).
//
// Production deployments that actually want the aggressive Robin-style
// release should set AUTO_RELEASE_GRACE_MINUTES=15. Disabling auto
// release entirely means abandoned bookings stay Confirmed forever and
// admins have to cancel them manually — fine for low-volume tenants.
func tickAutoRelease(ctx context.Context, pool *pgxpool.Pool) {
	// Default is DISABLED — admins must opt in explicitly. Originally
	// the scheduler aggressively flipped Confirmed→No Show 15 min past
	// start, which surprised operators and confused users ("I just
	// booked it, why is the room free again?"). The current default
	// preserves bookings until an admin marks them No Show via
	// POST /api/v1/admin/bookings/{id}/no-show (System Admin, Room
	// Admin, and Secretary only).
	if !envBool("AUTO_RELEASE_ENABLED", false) {
		return
	}
	grace := envInt("AUTO_RELEASE_GRACE_MINUTES", 60)
	cutoff := time.Now().Add(-time.Duration(grace) * time.Minute)
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
		log.Printf("auto-release: flipped %d bookings to No Show (grace=%dm)", n, grace)
	}
}

// envBool returns the boolean value of an env var, defaulting to def
// when unset or unparseable. Accepts true/1/yes (case-insensitive).
func envBool(key string, def bool) bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv(key)))
	if v == "" {
		return def
	}
	return v == "true" || v == "1" || v == "yes"
}

// envInt returns the integer value of an env var, defaulting to def
// when unset or unparseable.
func envInt(key string, def int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

func tickWeather(ctx context.Context, c *external.HKOClient, pool *pgxpool.Pool) {
	report, err := c.CurrentWeather(ctx)
	if err != nil {
		log.Printf("hko: %v", err)
		return
	}

	// 1) Auto-publish weather-driven broadcasts per tenant config.
	evaluateAutoBroadcasts(ctx, pool, report)

	// 2) Suspend bookings under severe signals (existing behaviour).
	suspending := ""
	for _, s := range report.Signals {
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

// evaluateAutoBroadcasts reads each tenant's broadcast_auto_rules and
// publishes a banner when a rule matches and hasn't fired within its
// cooldown window. Best-effort: per-tenant errors are logged, not fatal.
func evaluateAutoBroadcasts(ctx context.Context, pool *pgxpool.Pool, report external.WeatherReport) {
	maxSeverity := 0
	for _, s := range report.Signals {
		if s.Severity > maxSeverity {
			maxSeverity = s.Severity
		}
	}

	rows, err := pool.Query(ctx,
		`SELECT id, COALESCE(customization_config::text,'') FROM tenants`)
	if err != nil {
		log.Printf("auto-broadcast: list tenants: %v", err)
		return
	}
	type tc struct {
		id  string
		cfg string
	}
	var tenants []tc
	for rows.Next() {
		var t tc
		if rows.Scan(&t.id, &t.cfg) == nil {
			tenants = append(tenants, t)
		}
	}
	rows.Close()

	for _, t := range tenants {
		if t.cfg == "" {
			continue
		}
		var doc tenant.Customization
		if err := json.Unmarshal([]byte(t.cfg), &doc); err != nil {
			continue
		}
		for _, r := range doc.BroadcastAutoRules {
			if !r.Enabled {
				continue
			}
			match := false
			switch r.Metric {
			case "temp_above":
				match = report.TempC > r.Threshold
			case "temp_below":
				match = report.TempC < r.Threshold
			case "signal_at_least":
				match = float64(maxSeverity) >= r.Threshold
			}
			if !match {
				continue
			}
			cooldown := r.CooldownHours
			if cooldown <= 0 {
				cooldown = 6
			}
			// Skip if an identical-title broadcast for this tenant was
			// created within the cooldown window.
			var recent int
			_ = pool.QueryRow(ctx, `
				SELECT COUNT(*) FROM broadcasts
				 WHERE tenant_id = $1 AND title = $2
				   AND created_at > NOW() - ($3 || ' hours')::interval
			`, t.id, r.Title, cooldown).Scan(&recent)
			if recent > 0 {
				continue
			}
			sev := r.Severity
			if sev == "" {
				sev = "warning"
			}
			_, err := pool.Exec(ctx, `
				INSERT INTO broadcasts (id, tenant_id, title, content, start_date, end_date, filters)
				VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW() + ($4 || ' hours')::interval,
				        jsonb_build_object('severity', $5, 'auto_rule_id', $6))
			`, t.id, r.Title, r.Content, cooldown, sev, r.ID)
			if err != nil {
				log.Printf("auto-broadcast insert (tenant %s): %v", t.id, err)
				continue
			}
			log.Printf("auto-broadcast fired: tenant=%s rule=%s temp=%.1f sig=%d",
				t.id, r.Title, report.TempC, maxSeverity)
		}
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
