// Package middleware — idempotency.go.
//
// Clients that retry a POST after a network blip can end up with duplicate
// bookings. The fix is well-known: the client generates an Idempotency-Key
// (any opaque string) per logical request and sends it as a header. The
// server caches the *first* response for that key and returns the same
// response on retry instead of re-processing.
//
// We persist the cache in Postgres (table: idempotency_keys) so it
// survives restarts and works across replicas.
package middleware

import (
	"bytes"
	"context"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

const HeaderIdempotency = "Idempotency-Key"

// IdempotencyMiddleware wraps a handler and de-duplicates POSTs based on
// the Idempotency-Key header. Non-POST requests pass through unchanged.
type IdempotencyMiddleware struct {
	pool *pgxpool.Pool
}

func NewIdempotencyMiddleware(pool *pgxpool.Pool) *IdempotencyMiddleware {
	return &IdempotencyMiddleware{pool: pool}
}

func (m *IdempotencyMiddleware) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			next.ServeHTTP(w, r)
			return
		}
		key := r.Header.Get(HeaderIdempotency)
		if key == "" {
			next.ServeHTTP(w, r)
			return
		}

		// Look up the cached response first.
		ctx := r.Context()
		var (
			code int
			body []byte
		)
		err := m.pool.QueryRow(ctx,
			`SELECT response_code, response_body FROM idempotency_keys
              WHERE key = $1 AND request_path = $2 AND expires_at > NOW()`,
			key, r.URL.Path,
		).Scan(&code, &body)
		if err == nil && code != 0 {
			// Hit. Replay the original response.
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Idempotent-Replay", "true")
			w.WriteHeader(code)
			_, _ = w.Write(body)
			return
		}

		// Miss. Run the handler with a buffering ResponseWriter so we can
		// store the response. Note: this assumes the handler writes a
		// reasonably small body (which is true for all our POST endpoints).
		buf := &bufferingWriter{ResponseWriter: w, code: 200}
		next.ServeHTTP(buf, r)

		// Only cache 2xx responses — retrying a 4xx with the same key
		// might produce a different (better) result later.
		if buf.code < 200 || buf.code >= 300 {
			return
		}
		uid, _ := r.Context().Value("userID").(string)
		_, _ = m.pool.Exec(ctx,
			`INSERT INTO idempotency_keys (key, user_id, request_path, response_code, response_body)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (key) DO NOTHING`,
			key, uid, r.URL.Path, buf.code, buf.body.Bytes())
	})
}

type bufferingWriter struct {
	http.ResponseWriter
	code int
	body bytes.Buffer
}

func (b *bufferingWriter) WriteHeader(code int) {
	b.code = code
	b.ResponseWriter.WriteHeader(code)
}
func (b *bufferingWriter) Write(p []byte) (int, error) {
	b.body.Write(p)
	return b.ResponseWriter.Write(p)
}

// keyFromContext is a small helper a future handler could use if it
// wanted to access the idempotency key directly. Unused today; kept here
// because exposing a context-key type from the middleware is the
// conventional way to share it.
type ctxKey struct{}

func WithKey(ctx context.Context, key string) context.Context {
	return context.WithValue(ctx, ctxKey{}, key)
}
func KeyFrom(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(string)
	return v, ok
}
