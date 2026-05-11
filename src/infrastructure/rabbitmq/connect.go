// Package rabbitmq holds the AMQP connection helpers shared by every
// worker binary (cmd/worker, cmd/webhook_worker, cmd/graph_worker). Each
// worker just calls DialWithRetry instead of amqp.Dial, so a transient
// startup race or mid-operation reconnect doesn't crash the process.
package rabbitmq

import (
	"context"
	"errors"
	"log/slog"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// DialWithRetry attempts amqp.Dial with exponential backoff up to maxAttempts.
// Returns the live connection on success, or the last error after exhausting
// retries. Uses ctx for cancellation so SIGTERM doesn't get swallowed.
//
// Default schedule (maxAttempts=10): 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s, 30s, 30s
// — plenty of margin for a cold-start RabbitMQ that's still elected leadership.
func DialWithRetry(ctx context.Context, url string, maxAttempts int) (*amqp.Connection, error) {
	if maxAttempts <= 0 {
		maxAttempts = 10
	}
	delay := time.Second
	var lastErr error
	for i := 1; i <= maxAttempts; i++ {
		conn, err := amqp.Dial(url)
		if err == nil {
			if i > 1 {
				slog.Info("rabbitmq connected after retry", "attempts", i)
			}
			return conn, nil
		}
		lastErr = err
		slog.Warn("rabbitmq dial failed; retrying", "attempt", i, "max", maxAttempts, "delay", delay, "err", err)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}

		// Exponential backoff capped at 30s.
		if delay < 30*time.Second {
			delay *= 2
			if delay > 30*time.Second {
				delay = 30 * time.Second
			}
		}
	}
	return nil, errors.Join(errors.New("rabbitmq: exhausted dial retries"), lastErr)
}
