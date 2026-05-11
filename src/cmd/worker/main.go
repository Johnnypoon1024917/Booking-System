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
	"text/template"
	"time"

	"fsd-mrbs/src/domain/ics"
	"fsd-mrbs/src/domain/notification"
	"fsd-mrbs/src/infrastructure/email"
	"fsd-mrbs/src/infrastructure/postgres"
	"fsd-mrbs/src/infrastructure/rabbitmq"

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
		d.Ack(false)
	}
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
