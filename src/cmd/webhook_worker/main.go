// Webhook dispatcher worker.
//
// Pipeline:
//   booking write → publish("booking_events") → THIS WORKER:
//     1. for each active subscription that listens to this event,
//        insert a row into webhook_deliveries (status: pending)
//     2. immediately attempt delivery; on failure, schedule a retry
//
// Plus a periodic retry loop that picks up rows whose `next_attempt_at`
// has elapsed. Up to 5 attempts with exponential backoff (30s, 2m, 8m,
// 30m, 2h). After 5 failures the row is parked.
//
// HMAC-SHA256 of the raw JSON body is sent in `X-MRBS-Signature` so the
// receiver can verify authenticity using their stored secret.
package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"time"

	"fsd-mrbs/src/infrastructure/rabbitmq"

	"github.com/jackc/pgx/v5/pgxpool"
)

const queueName = "booking_events"

var backoff = []time.Duration{30 * time.Second, 2 * time.Minute, 8 * time.Minute, 30 * time.Minute, 2 * time.Hour}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	dbURL := os.Getenv("DB_DSN")
	if dbURL == "" {
		logger.Error("DB_DSN not set")
		os.Exit(1)
	}
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		logger.Error("db", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	rmqURL := os.Getenv("RABBITMQ_URL")
	if rmqURL == "" {
		rmqURL = "amqp://guest:guest@localhost:5672/"
	}
	conn, err := rabbitmq.DialWithRetry(context.Background(), rmqURL, 12)
	if err != nil {
		logger.Error("amqp dial", "err", err)
		os.Exit(1)
	}
	defer conn.Close()

	ch, err := conn.Channel()
	if err != nil {
		logger.Error("amqp channel", "err", err)
		os.Exit(1)
	}
	defer ch.Close()

	if _, err := ch.QueueDeclare(queueName, true, false, false, false, nil); err != nil {
		logger.Error("queue declare", "err", err)
		os.Exit(1)
	}
	msgs, err := ch.ConsumeWithContext(context.Background(), queueName, "webhook-worker", false, false, false, false, nil)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	d := &dispatcher{pool: pool, http: &http.Client{Timeout: 10 * time.Second}, log: logger}

	go d.retryLoop(context.Background())

	logger.Info("webhook worker ready")
	for m := range msgs {
		var ev map[string]any
		if err := json.Unmarshal(m.Body, &ev); err != nil {
			logger.Warn("decode", "err", err)
			m.Nack(false, false)
			continue
		}
		eventName := translateEvent(toString(ev["event"]))
		tenantID := toString(ev["tenant_id"])
		if eventName == "" || tenantID == "" {
			m.Ack(false)
			continue
		}
		d.enqueueAndAttempt(context.Background(), tenantID, eventName, m.Body)
		m.Ack(false)
	}
}

// translateEvent normalizes the internal event names ("BOOKING_CREATED")
// to the snake-case dotted form we expose to subscribers.
func translateEvent(s string) string {
	switch s {
	case "BOOKING_CREATED":            return "booking.created"
	case "BOOKING_PENDING_APPROVAL":   return "booking.pending_approval"
	case "BOOKING_APPROVED":           return "booking.approved"
	case "BOOKING_REJECTED":           return "booking.rejected"
	case "BOOKING_UPDATED":            return "booking.updated"
	case "BOOKING_CANCELLED":          return "booking.cancelled"
	}
	return ""
}

func toString(v any) string {
	s, _ := v.(string)
	return s
}

type dispatcher struct {
	pool *pgxpool.Pool
	http *http.Client
	log  *slog.Logger
}

// enqueueAndAttempt finds active subscriptions for the (tenant, event) pair,
// inserts a webhook_deliveries row for each, and immediately tries to POST.
func (d *dispatcher) enqueueAndAttempt(ctx context.Context, tenantID, event string, payload []byte) {
	rows, err := d.pool.Query(ctx, `
SELECT id, target_url, secret
FROM webhook_subscriptions
WHERE tenant_id = $1 AND is_active = TRUE AND $2 = ANY(events)`, tenantID, event)
	if err != nil {
		d.log.Error("subscriptions query", "err", err)
		return
	}
	defer rows.Close()
	type sub struct{ ID, TargetURL, Secret string }
	var subs []sub
	for rows.Next() {
		var s sub
		if err := rows.Scan(&s.ID, &s.TargetURL, &s.Secret); err == nil {
			subs = append(subs, s)
		}
	}

	for _, s := range subs {
		var deliveryID string
		err := d.pool.QueryRow(ctx, `
INSERT INTO webhook_deliveries (tenant_id, subscription_id, event, payload, next_attempt_at)
VALUES ($1, $2, $3, $4::jsonb, NOW())
RETURNING id`, tenantID, s.ID, event, payload).Scan(&deliveryID)
		if err != nil {
			d.log.Error("enqueue delivery", "err", err)
			continue
		}
		go d.attempt(ctx, deliveryID, s.TargetURL, s.Secret, event, payload, 0)
	}
}

// attempt sends one HTTP POST. On non-2xx or transport error, the row is
// updated with the next retry time. On success, delivered_at is set.
func (d *dispatcher) attempt(ctx context.Context, id, target, secret, event string, payload []byte, priorAttempts int) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-MRBS-Event", event)
	req.Header.Set("X-MRBS-Delivery", id)
	req.Header.Set("X-MRBS-Signature", sign(secret, payload))
	req.Header.Set("User-Agent", "fsd-mrbs-webhook/1.0")

	resp, err := d.http.Do(req)
	attempt := priorAttempts + 1
	now := time.Now()
	if err != nil {
		d.scheduleRetry(ctx, id, attempt, 0, err.Error(), now)
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		_, _ = d.pool.Exec(ctx, `
UPDATE webhook_deliveries SET attempt_count = $2, last_status = $3, last_error = '', delivered_at = NOW() WHERE id = $1`,
			id, attempt, resp.StatusCode)
		return
	}
	d.scheduleRetry(ctx, id, attempt, resp.StatusCode, fmt.Sprintf("HTTP %d: %s", resp.StatusCode, body), now)
}

func (d *dispatcher) scheduleRetry(ctx context.Context, id string, attempt, status int, errMsg string, now time.Time) {
	if attempt >= len(backoff) {
		// Park the row — admin can manually retry from the UI.
		_, _ = d.pool.Exec(ctx, `
UPDATE webhook_deliveries
   SET attempt_count = $2, last_status = $3, last_error = $4
 WHERE id = $1`, id, attempt, status, errMsg)
		d.log.Warn("delivery parked", "id", id, "attempts", attempt, "err", errMsg)
		return
	}
	next := now.Add(backoff[attempt-1])
	_, _ = d.pool.Exec(ctx, `
UPDATE webhook_deliveries
   SET attempt_count = $2, last_status = $3, last_error = $4, next_attempt_at = $5
 WHERE id = $1`, id, attempt, status, errMsg, next)
}

// retryLoop wakes every 30s and retries deliveries whose next_attempt_at
// has elapsed. Cap concurrency at 16 in-flight retries.
func (d *dispatcher) retryLoop(ctx context.Context) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	sem := make(chan struct{}, 16)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		rows, err := d.pool.Query(ctx, `
SELECT d.id, s.target_url, s.secret, d.event, d.payload, d.attempt_count
FROM webhook_deliveries d
JOIN webhook_subscriptions s ON s.id = d.subscription_id
WHERE d.delivered_at IS NULL AND d.attempt_count < 5 AND d.next_attempt_at <= NOW()
ORDER BY d.next_attempt_at ASC LIMIT 100`)
		if err != nil {
			d.log.Error("retry scan", "err", err)
			continue
		}
		for rows.Next() {
			var id, target, secret, event string
			var payload []byte
			var attempts int
			if err := rows.Scan(&id, &target, &secret, &event, &payload, &attempts); err != nil {
				continue
			}
			sem <- struct{}{}
			go func(id, target, secret, event string, payload []byte, attempts int) {
				defer func() { <-sem }()
				d.attempt(ctx, id, target, secret, event, payload, attempts)
			}(id, target, secret, event, payload, attempts)
		}
		rows.Close()
	}
}

// sign returns the HMAC-SHA256 of the body using the subscription secret,
// hex-encoded with the v1 prefix (Stripe-style format so receivers can
// rotate or version their verification logic).
func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}
