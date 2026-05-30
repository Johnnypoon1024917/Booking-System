// Package dbctx provides per-request connection pinning so RLS policies
// keyed on `app.current_tenant_id` actually fire.
//
// The previous design called `set_config(..., true)` on a pgxpool.Pool
// directly. That is documented as transaction-local; the moment the pool
// hands a different connection to the next statement (which is the
// default behaviour) the setting is gone. The result is a misleading
// "RLS configured" appearance with no actual enforcement.
//
// This package introduces an explicit request-scoped Tx that:
//
//  1. Acquires one connection from the pool.
//  2. Begins a transaction so set_config(..., true) is durable for the
//     lifetime of the request.
//  3. Sets app.current_tenant_id and app.current_user_id.
//  4. Stashes the resulting pgx.Tx in request context.
//
// Handlers and repositories opt in by calling ExecutorFromContext(ctx).
// When a pinned tx is present, every query runs through it and RLS
// policies see the tenant. When no tx is present (background jobs,
// public endpoints), the pool fallback is used — which is correct
// because those callers either don't need tenant context or set it
// explicitly.
//
// Adoption is incremental: existing repos that already include
// `WHERE tenant_id = $1` keep working unchanged through the pool. New
// or refactored repos use ExecutorFromContext so they pick up the tx
// when it exists.
package dbctx

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Executor is the small surface every pgx-based repo actually uses. Both
// *pgxpool.Pool and pgx.Tx satisfy it, so a repo can accept an Executor
// argument and stay agnostic to whether a request-pinned tx is in play.
type Executor interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type ctxKey struct{}

// WithTx stashes a request-scoped tx in ctx. Pass the same ctx into any
// repository call to make it run through the tx.
func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, ctxKey{}, tx)
}

// TxFromContext returns the pinned tx, if one was attached. Useful when
// a caller wants to take an explicit dependency on the tx (e.g. to use
// SAVEPOINTs) rather than the broader Executor surface.
func TxFromContext(ctx context.Context) (pgx.Tx, bool) {
	tx, ok := ctx.Value(ctxKey{}).(pgx.Tx)
	return tx, ok
}

// ExecutorFromContext returns the request-pinned tx when present, or
// falls back to the supplied pool. This is the helper repos should use.
func ExecutorFromContext(ctx context.Context, pool *pgxpool.Pool) Executor {
	if tx, ok := TxFromContext(ctx); ok {
		return tx
	}
	return pool
}

// RunInRequestTx is what the HTTP middleware calls. It acquires a single
// pool connection, begins a transaction, sets the tenant + user context
// inside that transaction, and runs fn with the tx attached to ctx.
//
// On a panic from fn the tx is rolled back; on normal return it is
// committed. If fn returns an error, the tx is rolled back so the audit
// hash chain and any side-effects are reverted.
func RunInRequestTx(
	ctx context.Context,
	pool *pgxpool.Pool,
	tenantID, userID string,
	fn func(ctx context.Context) error,
) error {
	if pool == nil {
		return errors.New("dbctx: nil pool")
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(context.Background())
		}
	}()

	// set_config with is_local=true ties the setting to this transaction,
	// so when the tx finishes the connection is left clean and safe for
	// the next pool checkout.
	if tenantID != "" {
		if _, err := tx.Exec(ctx,
			"SELECT set_config('app.current_tenant_id', $1, true)", tenantID); err != nil {
			return err
		}
	}
	if userID != "" {
		if _, err := tx.Exec(ctx,
			"SELECT set_config('app.current_user_id', $1, true)", userID); err != nil {
			return err
		}
	}

	if err := fn(WithTx(ctx, tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}
	committed = true
	return nil
}
