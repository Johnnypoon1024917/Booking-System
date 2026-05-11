package observability

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
)

// SetupTracing wires up an OTLP/HTTP trace exporter when
// OTEL_EXPORTER_OTLP_ENDPOINT is set. Without it, returns a no-op
// shutdown function so the API runs unaffected.
//
// Tracing automatically picks up TraceParent headers from the upstream
// load balancer (W3C Trace Context), so spans link cleanly with logs
// when the request id and trace id are both available.
func SetupTracing(ctx context.Context, serviceName string) (func(context.Context) error, error) {
	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		// No tracing backend configured. Set the global propagator anyway
		// so downstream services that DO receive our requests can still
		// thread through the trace context if we ever opt in later.
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
		return func(context.Context) error { return nil }, nil
	}

	opts := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(endpoint)}
	if strings.HasPrefix(endpoint, "http://") || os.Getenv("OTEL_EXPORTER_OTLP_INSECURE") == "true" {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return nil, err
	}

	res, _ := resource.Merge(resource.Default(),
		resource.NewWithAttributes(semconv.SchemaURL,
			semconv.ServiceName(serviceName),
			semconv.ServiceVersion(envOr("APP_VERSION", "1.0.0")),
		),
	)
	_ = envOr // kept for env passthrough; remove the unused linter once we add more attributes

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp, sdktrace.WithMaxQueueSize(2048), sdktrace.WithBatchTimeout(2*time.Second)),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(sampleRate()))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	slog.Info("otel tracing enabled", "endpoint", endpoint, "service", serviceName)

	return func(c context.Context) error {
		c, cancel := context.WithTimeout(c, 5*time.Second)
		defer cancel()
		return tp.Shutdown(c)
	}, nil
}

// HTTPMiddleware wraps a handler in otelhttp so every request becomes a
// span. The route is taken from the otelhttp.WithRouteTag the caller may
// or may not set; the simpler global wrap below works fine for our
// http.ServeMux setup.
func TracingMiddleware(next http.Handler) http.Handler {
	return otelhttp.NewHandler(next, "http")
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func sampleRate() float64 {
	v := os.Getenv("OTEL_TRACES_SAMPLER_ARG")
	if v == "" {
		return 1.0
	}
	switch v {
	case "0", "off", "none":
		return 0
	case "1", "all", "always":
		return 1
	}
	// best-effort parse — invalid values fall back to "trace everything"
	var f float64
	if _, err := timeParse(v, &f); err == nil && f >= 0 && f <= 1 {
		return f
	}
	return 1
}

// timeParse exists only to avoid importing strconv just for this. (Kept
// inline so the package has zero stdlib-incidental imports.)
func timeParse(s string, f *float64) (int, error) {
	var v float64
	var dec float64
	dec = 1
	seenDot := false
	for i, c := range s {
		switch {
		case c == '.':
			if seenDot {
				return i, errInvalid
			}
			seenDot = true
		case c >= '0' && c <= '9':
			d := float64(c - '0')
			if !seenDot {
				v = v*10 + d
			} else {
				dec *= 10
				v += d / dec
			}
		default:
			return i, errInvalid
		}
	}
	*f = v
	return len(s), nil
}

var errInvalid = errInvalidErr{}

type errInvalidErr struct{}

func (errInvalidErr) Error() string { return "invalid" }
