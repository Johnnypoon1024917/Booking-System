// graph_worker — Microsoft Graph (Outlook room mailbox) sync.
//
// Pipeline:
//   booking_events queue → this worker → Graph API
//
// Events handled: BOOKING_CREATED, BOOKING_APPROVED, BOOKING_UPDATED,
// BOOKING_CANCELLED, BOOKING_REJECTED. Failures requeue with backoff.
// Tenants without Microsoft credentials configured are silently skipped.
package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"time"

	"fsd-mrbs/src/application/usecase"
	"fsd-mrbs/src/infrastructure/integration"
	"fsd-mrbs/src/infrastructure/postgres"
	"fsd-mrbs/src/infrastructure/rabbitmq"

	"github.com/jackc/pgx/v5/pgxpool"
)

const queueName = "booking_events"

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	pool, err := pgxpool.New(context.Background(), os.Getenv("DB_DSN"))
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
	msgs, err := ch.ConsumeWithContext(context.Background(), queueName, "graph-worker", false, false, false, false, nil)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	uc := usecase.NewSyncOutlookUseCase(
		postgres.NewIntegrationCredentialRepo(pool),
		postgres.NewRoomMailboxRepo(pool),
		postgres.NewOutlookSyncRepo(pool),
		postgres.NewBookingRepository(pool),
		postgres.NewResourceRepo(pool),
		integration.NewGraphClient(15*time.Second),
	)

	logger.Info("graph worker ready")
	for m := range msgs {
		var ev struct {
			Event     string `json:"event"`
			TenantID  string `json:"tenant_id"`
			BookingID string `json:"booking_id"`
		}
		if err := json.Unmarshal(m.Body, &ev); err != nil {
			logger.Warn("decode", "err", err)
			m.Nack(false, false)
			continue
		}
		if ev.TenantID == "" || ev.BookingID == "" {
			m.Ack(false)
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := uc.HandleEvent(ctx, ev.Event, ev.TenantID, ev.BookingID)
		cancel()
		if err != nil {
			logger.Error("graph sync", "event", ev.Event, "booking", ev.BookingID, "err", err)
			m.Nack(false, true) // requeue — retry on a future delivery
			continue
		}
		m.Ack(false)
	}
}
