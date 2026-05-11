package usecase

import (
	"context"
	"errors"
	"time"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/integration"
	infraint "fsd-mrbs/src/infrastructure/integration"
)

// SyncOutlookUseCase pushes a single booking lifecycle event to Microsoft
// Graph. It's invoked from the graph_worker, which consumes the
// booking_events queue.
//
// The use case is idempotent:
//   - on create: insert event in mailbox, store its graph_id
//   - on update: PATCH the existing event (or insert if mapping missing)
//   - on cancel: DELETE the event and forget the mapping
type SyncOutlookUseCase struct {
	creds       integration.CredentialRepository
	mailboxes   integration.MailboxRepository
	syncMap     integration.OutlookSyncRepository
	bookings    booking.Repository
	resources   booking.ResourceRepository
	graph       *infraint.GraphClient
	defaultTZ   string
	defaultFrom string // optional fallback organizer address when booking has none
}

func NewSyncOutlookUseCase(
	creds integration.CredentialRepository,
	mailboxes integration.MailboxRepository,
	syncMap integration.OutlookSyncRepository,
	bookings booking.Repository,
	resources booking.ResourceRepository,
	graph *infraint.GraphClient,
) *SyncOutlookUseCase {
	return &SyncOutlookUseCase{
		creds: creds, mailboxes: mailboxes, syncMap: syncMap,
		bookings: bookings, resources: resources, graph: graph,
		defaultTZ: "Asia/Hong_Kong",
	}
}

// HandleEvent decides what to do based on event name. Event payload is
// a parsed booking_events message: {event, tenant_id, booking_id, ...}.
//
// Returns nil when the event is a no-op (no credentials, no mailbox map),
// so the caller (worker) can ack without retry.
func (uc *SyncOutlookUseCase) HandleEvent(ctx context.Context, eventName, tenantID, bookingID string) error {
	cred, err := uc.creds.Get(ctx, tenantID, integration.ProviderMicrosoft)
	if err != nil {
		if errors.Is(err, infraint.ErrNotFound) {
			return nil // tenant hasn't connected M365 yet
		}
		return err
	}
	if !cred.IsActive {
		return nil
	}

	switch eventName {
	case "BOOKING_CREATED", "BOOKING_APPROVED":
		return uc.upsert(ctx, cred, bookingID)
	case "BOOKING_UPDATED":
		return uc.upsert(ctx, cred, bookingID)
	case "BOOKING_CANCELLED", "BOOKING_REJECTED":
		return uc.cancel(ctx, cred, bookingID)
	}
	return nil
}

func (uc *SyncOutlookUseCase) upsert(ctx context.Context, cred *integration.Credential, bookingID string) error {
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return err
	}
	mailbox, err := uc.mailboxes.GetByResource(ctx, b.ResourceID)
	if err != nil || mailbox == nil || !mailbox.IsActive {
		return nil // resource isn't mapped to a mailbox
	}
	res, _ := uc.resources.GetByID(ctx, b.ResourceID)
	tok, err := uc.graph.Token(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret)
	if err != nil {
		return err
	}

	event := infraint.Event{
		Subject: subjectFor(res, b),
		Body:    infraint.EventBody{ContentType: "HTML", Content: bodyFor(b)},
		Start:   infraint.EventDateTime{DateTime: b.StartTime.In(time.UTC).Format("2006-01-02T15:04:05"), TimeZone: "UTC"},
		End:     infraint.EventDateTime{DateTime: b.EndTime.In(time.UTC).Format("2006-01-02T15:04:05"), TimeZone: "UTC"},
		Location: infraint.EventLocation{DisplayName: locationFor(res)},
	}

	existing, _ := uc.syncMap.Get(ctx, bookingID)
	if existing != nil {
		if err := uc.graph.UpdateEvent(ctx, tok, mailbox.MailboxUPN, existing.GraphID, event); err == nil {
			return nil
		}
		// fall through to recreate if update failed (e.g. event was deleted manually)
	}
	id, ical, err := uc.graph.CreateEvent(ctx, tok, mailbox.MailboxUPN, event)
	if err != nil {
		return err
	}
	return uc.syncMap.Save(ctx, integration.OutlookSyncRecord{
		BookingID: bookingID, TenantID: b.TenantID,
		MailboxUPN: mailbox.MailboxUPN, GraphID: id, ICalUID: ical,
	})
}

func (uc *SyncOutlookUseCase) cancel(ctx context.Context, cred *integration.Credential, bookingID string) error {
	rec, err := uc.syncMap.Get(ctx, bookingID)
	if err != nil || rec == nil {
		return nil
	}
	tok, err := uc.graph.Token(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret)
	if err != nil {
		return err
	}
	if err := uc.graph.CancelEvent(ctx, tok, rec.MailboxUPN, rec.GraphID); err != nil {
		return err
	}
	return uc.syncMap.Delete(ctx, bookingID)
}

func subjectFor(res *booking.Resource, b booking.Booking) string {
	name := "Booking"
	if res != nil {
		name = res.Name
	}
	if b.Status == booking.StatusPendingApproval {
		return "[Pending] " + name
	}
	return name
}
func bodyFor(b booking.Booking) string {
	return "Booking " + b.ID + " synced from FSD MRBS."
}
func locationFor(res *booking.Resource) string {
	if res == nil {
		return "Resource"
	}
	return res.Name + " · " + res.Location
}
