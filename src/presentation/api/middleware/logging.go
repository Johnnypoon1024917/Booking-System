// Package middleware — logging.go.
//
// Sets up structured logging (`log/slog`) at process start and provides a
// per-request middleware that:
//
//   1. Generates / forwards a request ID (Header: `X-Request-Id`).
//   2. Logs method, path, status, duration, request id, user, tenant.
//
// Hand off the returned logger via context to handlers that want richer
// log lines (most don't — the per-request line covers the common case).
package middleware

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

// HeaderRequestID — the convention header name. Trace exporters and
// log aggregators are most likely to recognise this one.
const HeaderRequestID = "X-Request-Id"

type ctxKeyLogger struct{}
type ctxKeyRequestID struct{}

// SetupLogger configures the global slog handler exactly once. JSON in
// production, human-friendly text in dev when LOG_FORMAT=text.
func SetupLogger() *slog.Logger {
	level := slog.LevelInfo
	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	var h slog.Handler
	if strings.EqualFold(os.Getenv("LOG_FORMAT"), "text") {
		h = slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	} else {
		h = slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: level})
	}
	logger := slog.New(h)
	slog.SetDefault(logger)
	return logger
}

// LoggerFromCtx returns the per-request logger (with request_id baked in).
// Falls back to the default logger if not set.
func LoggerFromCtx(ctx context.Context) *slog.Logger {
	if l, ok := ctx.Value(ctxKeyLogger{}).(*slog.Logger); ok {
		return l
	}
	return slog.Default()
}

// RequestIDFromCtx returns the request id assigned by the logging
// middleware (or the upstream proxy via header).
func RequestIDFromCtx(ctx context.Context) string {
	v, _ := ctx.Value(ctxKeyRequestID{}).(string)
	return v
}

// Logging is middleware that timestamps, IDs, and logs every request.
func Logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rid := r.Header.Get(HeaderRequestID)
		if rid == "" {
			rid = newRequestID()
		}
		w.Header().Set(HeaderRequestID, rid)

		l := slog.With("rid", rid, "method", r.Method, "path", r.URL.Path)
		ctx := context.WithValue(r.Context(), ctxKeyLogger{}, l)
		ctx = context.WithValue(ctx, ctxKeyRequestID{}, rid)
		r = r.WithContext(ctx)

		start := time.Now()
		ww := &statusWriter{ResponseWriter: w, status: 200}
		next.ServeHTTP(ww, r)
		dur := time.Since(start)

		uid, _ := ctx.Value("userID").(string)
		tid, _ := ctx.Value("tenant_id").(string)
		l.Info("http",
			"status", ww.status,
			"dur_ms", dur.Milliseconds(),
			"user", uid,
			"tenant", tid,
		)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Hijack lets the underlying ResponseWriter take over the connection — required
// for the realtime WebSocket endpoint. Without this passthrough the gorilla
// upgrader panics with "response does not implement http.Hijacker".
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		s.status = http.StatusSwitchingProtocols
		return h.Hijack()
	}
	return nil, nil, errors.New("upstream ResponseWriter does not implement http.Hijacker")
}

// Flush passes through to the wrapped writer for SSE / streaming responses.
func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func newRequestID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
