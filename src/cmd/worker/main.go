// Notification worker.
//
// Consumes booking_events from RabbitMQ, looks up the per-tenant
// notification template, renders it, generates the ICS attachment, and
// ships email via SMTP. Falls back to log-only sender when SMTP_HOST is
// not configured.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"text/template"
	"time"

	"fsd-mrbs/src/domain/ics"
	"fsd-mrbs/src/domain/notification"
	"fsd-mrbs/src/infrastructure/email"
	"fsd-mrbs/src/infrastructure/postgres"
	"fsd-mrbs/src/infrastructure/rabbitmq"
	"fsd-mrbs/src/infrastructure/webpush"

	"github.com/jackc/pgx/v5/pgxpool"
)

const queueName = "booking_events"

type bookingEvent struct {
	Event        string            `json:"event"`
	TenantID     string            `json:"tenant_id"`
	BookingID    string            `json:"booking_id"`
	ResourceID   string            `json:"resource_id"`
	UserID       string            `json:"user_id"`
	StartTime    time.Time         `json:"start_time"`
	EndTime      time.Time         `json:"end_time"`
	Status       string            `json:"status"`
	MeetingURL   string            `json:"meeting_url"`
	Email        string            `json:"email"`
	UserName     string            `json:"user_name"`
	ResourceName string            `json:"resource_name"`
	CustomData   map[string]string `json:"custom_data"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	url := os.Getenv("RABBITMQ_URL")
	if url == "" {
		url = "amqp://guest:guest@localhost:5672/"
	}
	dbURL := os.Getenv("DB_DSN")
	pool, err := pgxpool.New(context.Background(), dbURL)
	if err != nil {
		logger.Error("db", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	templateRepo := postgres.NewNotificationTemplateRepository(pool)

	conn, err := rabbitmq.DialWithRetry(context.Background(), url, 12)
	if err != nil {
		logger.Error("rabbitmq dial", "err", err)
		os.Exit(1)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		logger.Error("rabbitmq channel", "err", err)
		os.Exit(1)
	}
	defer ch.Close()
	if _, err := ch.QueueDeclare(queueName, true, false, false, false, nil); err != nil {
		logger.Error("queue declare", "err", err)
		os.Exit(1)
	}
	msgs, err := ch.ConsumeWithContext(context.Background(), queueName, "notification-worker", false, false, false, false, nil)
	if err != nil {
		logger.Error("consume", "err", err)
		os.Exit(1)
	}

	sender := pickSender(logger)
	pushSender, err := webpush.NewSenderFromEnv(os.Getenv)
	if err != nil {
		logger.Warn("webpush sender disabled", "err", err)
	} else if pushSender == nil {
		logger.Info("VAPID keys unset; web push disabled")
	} else {
		logger.Info("webpush sender ready")
	}
	logger.Info("notification worker ready")

	for d := range msgs {
		var ev bookingEvent
		if err := json.Unmarshal(d.Body, &ev); err != nil {
			logger.Warn("decode", "err", err)
			d.Nack(false, false)
			continue
		}
		if err := dispatch(context.Background(), sender, templateRepo, ev); err != nil {
			logger.Warn("dispatch", "err", err, "event", ev.Event, "booking", ev.BookingID)
			d.Nack(false, true)
			continue
		}
		// Web push is best-effort: a failure here MUST NOT requeue the
		// message because email already went out. We just log and move on.
		if pushSender != nil {
			fanOutWebPush(context.Background(), pool, pushSender, ev, logger)
		}
		d.Ack(false)
	}
}

// fanOutWebPush sends an empty-body push to every active subscription
// owned by the booking's user. A 410/404 from the push service is taken
// as a signal to delete the dead subscription so the worker doesn't keep
// retrying it.
func fanOutWebPush(ctx context.Context, pool *pgxpool.Pool, sender *webpush.Sender, ev bookingEvent, logger *slog.Logger) {
	if ev.UserID == "" {
		return
	}
	rows, err := pool.Query(ctx,
		`SELECT id::text, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1::uuid`,
		ev.UserID)
	if err != nil {
		logger.Warn("push subscriptions query", "err", err)
		return
	}
	defer rows.Close()
	type sub struct {
		ID, Endpoint, P256dh, Auth string
	}
	var subs []sub
	for rows.Next() {
		var s sub
		if rows.Scan(&s.ID, &s.Endpoint, &s.P256dh, &s.Auth) == nil {
			subs = append(subs, s)
		}
	}
	payload := pushPayloadFor(ev)
	for _, s := range subs {
		sub := webpush.Subscription{Endpoint: s.Endpoint, P256dh: s.P256dh, Auth: s.Auth}
		var (
			res *webpush.Result
			err error
		)
		// Native push tokens (Capacitor) go through the same endpoint
		// shape but we can't aes128gcm-encrypt them — the OS push
		// services don't follow RFC 8291. Detect those and fall back to
		// the empty-body trigger; the mobile shell fetches content over
		// the API. Standard Web Push subscriptions get an encrypted
		// payload so the service worker can render the notification
		// without an extra round-trip.
		if strings.HasPrefix(s.Endpoint, "native:") || s.P256dh == "" || s.P256dh == "native" {
			res, err = sender.Send(ctx, sub, 60, "high")
		} else {
			res, err = sender.SendEncrypted(ctx, sub, payload, 60, "high")
		}
		if err != nil {
			logger.Warn("push send", "err", err, "endpoint", s.Endpoint)
			continue
		}
		if res.IsExpired() {
			if _, derr := pool.Exec(ctx, `DELETE FROM push_subscriptions WHERE id = $1`, s.ID); derr != nil {
				logger.Warn("push prune", "err", derr)
			}
		}
	}
}

// pushPayloadFor builds the JSON envelope the service worker (push-sw.js)
// expects: title, body, url. We deliberately do NOT carry meeting subject
// or guest names in the body — the push payload is visible on a locked
// screen, so we limit it to the minimum the user needs to decide whether
// to open the app for the full detail.
func pushPayloadFor(ev bookingEvent) []byte {
	title := "FSD MRBS"
	body := "Your booking has been updated."
	switch ev.Event {
	case "BOOKING_CREATED":
		body = "Booking confirmed."
	case "BOOKING_PENDING_APPROVAL":
		body = "Booking submitted for approval."
	case "BOOKING_APPROVED":
		body = "Your booking was approved."
	case "BOOKING_REJECTED":
		body = "Your booking was rejected."
	case "BOOKING_UPDATED":
		body = "Your booking was updated."
	case "BOOKING_CANCELLED":
		body = "Your booking was cancelled."
	}
	url := "/app/my"
	if ev.BookingID != "" {
		url = "/app/my?booking=" + ev.BookingID
	}
	b, _ := json.Marshal(map[string]any{
		"title": title, "body": body, "url": url, "tag": "mrbs-" + ev.BookingID,
	})
	return b
}

func pickSender(logger *slog.Logger) email.Sender {
	if s, err := email.FromEnv(); err == nil {
		logger.Info("smtp configured")
		return s
	}
	logger.Info("SMTP_HOST not set; using log-only sender")
	return email.LogSender{}
}

// fallback templates used when no per-tenant template is configured.
var fallbackSubject = template.Must(template.New("s").Parse(`Booking {{.Status}}: {{.ResourceName}}`))
var fallbackBody = template.Must(template.New("b").Parse(`<p>Hello {{.UserName}},</p>
<p>Your booking for <strong>{{.ResourceName}}</strong> is now <strong>{{.Status}}</strong>.</p>
<ul>
  <li>Start: {{.StartTime.Format "2006-01-02 15:04"}}</li>
  <li>End:   {{.EndTime.Format "2006-01-02 15:04"}}</li>
  {{if .MeetingURL}}<li>Online: <a href="{{.MeetingURL}}">{{.MeetingURL}}</a></li>{{end}}
</ul>
<p>The attached calendar invite (.ics) will update your Outlook / Gmail automatically.</p>`))

// templateTypeFor maps an event name to a notification template type.
func templateTypeFor(event string) string {
	switch event {
	case "BOOKING_CANCELLED", "BOOKING_REJECTED":
		return notification.TemplateTypeCancellation
	default:
		return notification.TemplateTypeConfirmation
	}
}

func dispatch(ctx context.Context, s email.Sender, repo notification.Repository, ev bookingEvent) error {
	if ev.Email == "" {
		// upstream forgot to enrich — log and ack so we don't loop
		slog.Warn("missing email; dropping", "booking", ev.BookingID)
		return s.Send(email.Message{Subject: "[no recipient]", HTMLBody: ev.Event})
	}

	subj, body := renderTemplate(ctx, repo, ev)

	method := ics.MethodRequest
	if ev.Event == "BOOKING_CANCELLED" || ev.Event == "BOOKING_REJECTED" {
		method = ics.MethodCancel
	}
	cal := ics.Encode(ics.Event{
		UID:         ev.BookingID + "@fsd-mrbs",
		Summary:     ev.ResourceName,
		Description: "Status: " + ev.Status,
		Start:       ev.StartTime,
		End:         ev.EndTime,
		URL:         ev.MeetingURL,
		Method:      method,
		Attendees:   []ics.Attendee{{Email: ev.Email, Name: ev.UserName}},
	})

	return s.Send(email.Message{
		From:          getFrom(),
		To:            []string{ev.Email},
		Subject:       subj,
		HTMLBody:      body,
		ICSAttachment: cal,
		ICSFilename:   "booking-" + ev.BookingID + ".ics",
	})
}

// renderTemplate first tries the per-tenant notification_template; if
// missing or invalid, falls back to the inline default.
func renderTemplate(ctx context.Context, repo notification.Repository, ev bookingEvent) (string, string) {
	if repo != nil && ev.TenantID != "" {
		if t, err := repo.GetByTenantAndType(ctx, ev.TenantID, templateTypeFor(ev.Event)); err == nil && t != nil {
			subj, body, ok := renderUserTemplate(t.Subject, t.BodyTemplate, ev)
			if ok {
				return subj, body
			}
		}
	}
	var sb, bb bytes.Buffer
	_ = fallbackSubject.Execute(&sb, ev)
	_ = fallbackBody.Execute(&bb, ev)
	return sb.String(), bb.String()
}

func renderUserTemplate(subjectTpl, bodyTpl string, ev bookingEvent) (string, string, bool) {
	st, err := template.New("s").Parse(subjectTpl)
	if err != nil {
		return "", "", false
	}
	bt, err := template.New("b").Parse(bodyTpl)
	if err != nil {
		return "", "", false
	}
	var sb, bb bytes.Buffer
	if err := st.Execute(&sb, ev); err != nil {
		return "", "", false
	}
	if err := bt.Execute(&bb, ev); err != nil {
		return "", "", false
	}
	return sb.String(), bb.String(), true
}

func getFrom() string {
	if v := os.Getenv("SMTP_FROM"); v != "" {
		return v
	}
	return "no-reply@fsd-mrbs.local"
}
