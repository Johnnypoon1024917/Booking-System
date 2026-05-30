// Package auditlog is a thin convenience layer over audit.Repository that
// lets handlers emit audit events without taking the repository as a
// constructor dependency. main.go registers the concrete sink at boot;
// callers use the package-level Record / Denied / Failure helpers.
//
// The sink is intentionally a single process-wide value because audit
// emission is cross-cutting and the alternative (passing audit.Repository
// into every handler factory) is mechanical noise that obscures real
// logic. Tests can override with SetSink.
package auditlog

import (
	"context"
	"log"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"fsd-mrbs/src/domain/audit"

	"github.com/google/uuid"
)

// sink is set once at boot. Reads use atomic.Value so middleware and
// handlers can call into it without locking on the hot path.
var sink atomic.Value // holds audit.Repository

// SetSink registers the concrete repository used for all subsequent
// Record / Denied / Failure calls. Passing nil clears the sink — useful
// for tests that don't want audit side-effects.
func SetSink(repo audit.Repository) {
	if repo == nil {
		sink.Store((audit.Repository)(nil))
		return
	}
	sink.Store(repo)
}

// Event captures the variable parts of an audit entry. The required
// scalar context (tenant, actor, ip, ua, request_id, session_id) is
// pulled from the HTTP request automatically.
type Event struct {
	Action       string
	Outcome      string
	Severity     string
	TargetEntity string
	TargetID     string
	Previous     map[string]interface{}
	Next         map[string]interface{}
	Detail       string
}

// Record persists an audit entry for the in-flight request. Failures
// are logged but never returned: audit emission must not affect the
// caller's response semantics. When no sink is configured the call is
// a no-op so unit tests don't need to wire one up.
func Record(r *http.Request, ev Event) {
	repo, _ := sink.Load().(audit.Repository)
	if repo == nil {
		return
	}
	tenantID, _ := r.Context().Value("tenantID").(uuid.UUID)
	userID, _ := r.Context().Value("userID").(string)
	reqID, _ := r.Context().Value("requestID").(string)
	sessID, _ := r.Context().Value("sessionID").(string)
	entry := audit.AuditEntry{
		ID:            uuid.NewString(),
		TenantID:      tenantID.String(),
		Timestamp:     time.Now().UTC(),
		ActorUserID:   userID,
		ActionType:    ev.Action,
		TargetEntity:  ev.TargetEntity,
		TargetID:      ev.TargetID,
		PreviousState: ev.Previous,
		NewState:      stateWithDetail(ev.Next, ev.Detail),
		IPAddress:     clientIP(r),
		UserAgent:     r.UserAgent(),
		Outcome:       orInfo(ev.Outcome, audit.OutcomeSuccess),
		Severity:      orInfo(ev.Severity, audit.SeverityInfo),
		SessionID:     sessID,
		RequestID:     reqID,
	}
	if err := repo.Save(r.Context(), entry); err != nil {
		log.Printf("audit emit %s/%s failed: %v", ev.Action, ev.TargetID, err)
	}
}

// Denied is a convenience for "policy refused the action" — auth failure,
// RBAC reject, validation reject. These are higher-signal than ordinary
// errors and should be SIEM-routable.
func Denied(r *http.Request, action, targetEntity, targetID, detail string) {
	Record(r, Event{
		Action:       action,
		Outcome:      audit.OutcomeDenied,
		Severity:     audit.SeverityWarning,
		TargetEntity: targetEntity,
		TargetID:     targetID,
		Detail:       detail,
	})
}

// Failure marks an attempted action that errored out due to a server
// fault (DB error, downstream timeout). Useful for correlating outages.
func Failure(r *http.Request, action, targetEntity, targetID, detail string) {
	Record(r, Event{
		Action:       action,
		Outcome:      audit.OutcomeFailure,
		Severity:     audit.SeverityWarning,
		TargetEntity: targetEntity,
		TargetID:     targetID,
		Detail:       detail,
	})
}

func stateWithDetail(next map[string]interface{}, detail string) map[string]interface{} {
	if detail == "" {
		return next
	}
	if next == nil {
		return map[string]interface{}{"detail": detail}
	}
	next["detail"] = detail
	return next
}

func orInfo(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// clientIP returns just the IP portion (no port) of the request's
// source. The audit_entries.ip_address column is the Postgres `inet`
// type, which rejects "host:port" — so we strip the port before storing.
// X-Forwarded-For takes precedence when present (set by a trusted
// reverse proxy); we honour the first hop.
func clientIP(r *http.Request) string {
	raw := r.RemoteAddr
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		raw = xff
		if comma := strings.Index(raw, ","); comma > 0 {
			raw = raw[:comma]
		}
	}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(raw); err == nil {
		return host
	}
	return raw
}

// RecordContext is a context-only variant for code paths that don't have
// a *http.Request (background workers, scheduler jobs). The caller must
// pre-populate ctx with the same conventional keys.
func RecordContext(ctx context.Context, ev Event) {
	repo, _ := sink.Load().(audit.Repository)
	if repo == nil {
		return
	}
	tenantID, _ := ctx.Value("tenantID").(uuid.UUID)
	userID, _ := ctx.Value("userID").(string)
	reqID, _ := ctx.Value("requestID").(string)
	entry := audit.AuditEntry{
		ID:            uuid.NewString(),
		TenantID:      tenantID.String(),
		Timestamp:     time.Now().UTC(),
		ActorUserID:   userID,
		ActionType:    ev.Action,
		TargetEntity:  ev.TargetEntity,
		TargetID:      ev.TargetID,
		PreviousState: ev.Previous,
		NewState:      stateWithDetail(ev.Next, ev.Detail),
		Outcome:       orInfo(ev.Outcome, audit.OutcomeSuccess),
		Severity:      orInfo(ev.Severity, audit.SeverityInfo),
		RequestID:     reqID,
	}
	if err := repo.Save(ctx, entry); err != nil {
		log.Printf("audit emit (bg) %s/%s failed: %v", ev.Action, ev.TargetID, err)
	}
}
