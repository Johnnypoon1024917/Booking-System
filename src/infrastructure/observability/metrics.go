// Package observability holds Prometheus metrics + OpenTelemetry tracing
// glue. Both are best-effort: the API works fine if the OTLP endpoint is
// down, and `/metrics` is always exposed locally for scraping.
package observability

import (
	"bufio"
	"errors"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ---- Metric registry --------------------------------------------------------

var (
	requestDuration = promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "http_request_duration_seconds",
		Help:    "HTTP request duration in seconds, by route and status code.",
		Buckets: []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
	}, []string{"method", "route", "status"})

	requestsTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "http_requests_total",
		Help: "Total HTTP requests, by route and status code.",
	}, []string{"method", "route", "status"})

	BookingsCreated = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mrbs_bookings_created_total",
		Help: "Bookings successfully created, by tenant and resource asset type.",
	}, []string{"tenant", "asset_type"})

	BookingConflicts = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mrbs_booking_conflicts_total",
		Help: "Booking attempts that lost the conflict / EXCLUDE constraint check.",
	}, []string{"tenant"})

	ApprovalsDecided = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mrbs_approvals_decided_total",
		Help: "Approval decisions, by tenant and outcome.",
	}, []string{"tenant", "decision"})

	WebhookDeliveriesTotal = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "mrbs_webhook_deliveries_total",
		Help: "Webhook delivery attempts, by event and outcome.",
	}, []string{"event", "outcome"})

	WSConnectionsGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "mrbs_websocket_connections",
		Help: "Currently connected realtime WebSocket clients.",
	})
)

// MetricsHandler returns the http.Handler that scrapes expose at /metrics.
func MetricsHandler() http.Handler { return promhttp.Handler() }

// HTTPMiddleware records a duration histogram and counter per request.
// Route is taken from the URL path with high-cardinality segments
// trimmed (last UUID-shaped segment becomes "{id}").
func HTTPMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := &statusRecorder{ResponseWriter: w, code: 200}
		next.ServeHTTP(ww, r)
		dur := time.Since(start).Seconds()
		route := normalizeRoute(r.URL.Path)
		status := strconv.Itoa(ww.code)
		requestDuration.WithLabelValues(r.Method, route, status).Observe(dur)
		requestsTotal.WithLabelValues(r.Method, route, status).Inc()
	})
}

type statusRecorder struct {
	http.ResponseWriter
	code int
}

func (s *statusRecorder) WriteHeader(c int) { s.code = c; s.ResponseWriter.WriteHeader(c) }

// Hijack passthrough so the wrapper doesn't break WebSocket upgrades.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if h, ok := s.ResponseWriter.(http.Hijacker); ok {
		s.code = http.StatusSwitchingProtocols
		return h.Hijack()
	}
	return nil, nil, errors.New("upstream ResponseWriter does not implement http.Hijacker")
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// normalizeRoute collapses high-cardinality path segments (UUIDs and
// numeric IDs) to literal placeholders so we don't blow up the cardinality
// of our histogram series.
func normalizeRoute(p string) string {
	out := make([]byte, 0, len(p))
	for i := 0; i < len(p); {
		if p[i] != '/' {
			out = append(out, p[i])
			i++
			continue
		}
		out = append(out, '/')
		i++
		j := i
		for j < len(p) && p[j] != '/' {
			j++
		}
		seg := p[i:j]
		if isLikelyID(seg) {
			out = append(out, []byte("{id}")...)
		} else {
			out = append(out, seg...)
		}
		i = j
	}
	return string(out)
}

func isLikelyID(s string) bool {
	if len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-' {
		return true
	}
	if len(s) > 0 {
		allDigits := true
		for _, c := range s {
			if c < '0' || c > '9' {
				allDigits = false
				break
			}
		}
		if allDigits {
			return true
		}
	}
	return false
}
