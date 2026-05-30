// Package middleware — request-pinned database transaction (dbtx.go).
//
// WithTenantTx pairs with infrastructure/dbctx to give RLS policies a
// real `app.current_tenant_id` to compare against. Wrap any handler that
// must enforce tenant isolation at the policy layer with this middleware
// AFTER the tenant middleware has populated the request context.
//
// Usage:
//
//	handler := middleware.WithTenantTx(pool)(
//	    middleware.RequireRoleHandler(roles, h.Action),
//	)
//
// Handlers downstream get a request context carrying a pgx.Tx that
// dbctx.ExecutorFromContext returns instead of the bare pool.
package middleware

import (
	"context"
	"errors"
	"net/http"

	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// errCommitAborted is returned by the in-tx callback to signal that the
// HTTP handler reported a 5xx; the surrounding RunInRequestTx then rolls
// the transaction back rather than committing partial state.
var errCommitAborted = errors.New("dbtx: handler reported failure, rolling back")

// WithTenantTx returns middleware that opens a per-request transaction
// bound to the caller's tenant + user, runs the wrapped handler inside
// it, and commits on a 2xx/3xx/4xx response. On 5xx or panic the tx is
// rolled back.
func WithTenantTx(pool *pgxpool.Pool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tenantID, _ := r.Context().Value(TenantIDKey).(uuid.UUID)
			userID, _ := r.Context().Value("userID").(string)
			if tenantID == (uuid.UUID{}) {
				next.ServeHTTP(w, r)
				return
			}
			rec := &txStatusRecorder{ResponseWriter: w, status: http.StatusOK}
			err := dbctx.RunInRequestTx(r.Context(), pool, tenantID.String(), userID,
				func(ctx context.Context) error {
					next.ServeHTTP(rec, r.WithContext(ctx))
					if rec.status >= 500 {
						return errCommitAborted
					}
					return nil
				})
			if err != nil && !errors.Is(err, errCommitAborted) && !rec.wroteHeader {
				http.Error(w, "transaction setup failed", http.StatusInternalServerError)
				return
			}
		})
	}
}

// txStatusRecorder mirrors loggingMiddleware.statusRecorder but is kept
// private to this file so the two stay independent. It captures the
// status code so the middleware can decide commit vs rollback.
type txStatusRecorder struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
}

func (s *txStatusRecorder) WriteHeader(code int) {
	if !s.wroteHeader {
		s.status = code
		s.wroteHeader = true
		s.ResponseWriter.WriteHeader(code)
	}
}

func (s *txStatusRecorder) Write(b []byte) (int, error) {
	if !s.wroteHeader {
		s.wroteHeader = true
	}
	return s.ResponseWriter.Write(b)
}
