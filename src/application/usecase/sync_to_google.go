// One-way sync of FSD MRBS bookings into Google Calendar.
//
// This is intentionally one-way: MRBS is authoritative. Google's event
// status moves to "cancelled" when an MRBS booking is cancelled, and
// time/title changes propagate via PATCH. Inbound responses (RSVPs,
// declines) are not consumed in this revision; a future "reconcile_google_event"
// usecase parallels reconcile_graph_event.go for that.
//
// The integration looks up two pieces of state per booking:
//
//	• tenant credentials (parsed from integration_credentials)
//	• a target calendar id — typically the host user's calendar, with
//	  the room added as an attendee. Resource-mailbox calendars are
//	  modeled separately and not yet wired here.
package usecase

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"fsd-mrbs/src/domain/booking"
	"fsd-mrbs/src/domain/integration"
	infraintegration "fsd-mrbs/src/infrastructure/integration"
)

type SyncToGoogleUseCase struct {
	bookings booking.Repository
	creds    integration.CredentialRepository
	client   *infraintegration.GoogleClient
}

func NewSyncToGoogleUseCase(
	bookings booking.Repository,
	creds integration.CredentialRepository,
	client *infraintegration.GoogleClient,
) *SyncToGoogleUseCase {
	return &SyncToGoogleUseCase{bookings: bookings, creds: creds, client: client}
}

// PushBooking sends the current state of a booking to Google. If the
// caller passed a non-empty remoteEventID, we PATCH; otherwise we
// create. Returns the (possibly new) remote event id so the caller can
// persist it on the booking row for future updates.
func (uc *SyncToGoogleUseCase) PushBooking(
	ctx context.Context,
	tenantID, bookingID, remoteEventID, subject, calID string,
) (string, error) {
	b, err := uc.bookings.FindByID(ctx, bookingID)
	if err != nil {
		return "", fmt.Errorf("booking lookup: %w", err)
	}
	creds, err := uc.tenantCreds(ctx, tenantID)
	if err != nil {
		return "", err
	}
	ev := uc.buildEvent(b, remoteEventID)
	if b.Status == booking.StatusCancelled {
		// Cancellation path: tag the event as cancelled (Google retains
		// the row for audit) so attendees see the strike-through.
		ev.Status = "cancelled"
	}
	id, err := uc.client.UpsertEvent(ctx, creds, subject, calID, ev)
	if err != nil {
		return "", err
	}
	return id, nil
}

// RemoveBooking deletes the remote event entirely. Used when an admin
// hard-deletes a booking row rather than cancelling it.
func (uc *SyncToGoogleUseCase) RemoveBooking(ctx context.Context, tenantID, subject, calID, remoteEventID string) error {
	if remoteEventID == "" {
		return nil
	}
	creds, err := uc.tenantCreds(ctx, tenantID)
	if err != nil {
		return err
	}
	return uc.client.DeleteEvent(ctx, creds, subject, calID, remoteEventID)
}

func (uc *SyncToGoogleUseCase) tenantCreds(ctx context.Context, tenantID string) (*infraintegration.GoogleCreds, error) {
	c, err := uc.creds.Get(ctx, tenantID, integration.ProviderGoogle)
	if err != nil {
		return nil, fmt.Errorf("google credentials: %w", err)
	}
	if c == nil || c.ClientSecret == "" {
		return nil, fmt.Errorf("google credentials not configured for tenant %s", tenantID)
	}
	// ClientSecret carries the service-account JSON blob (Reveal-decrypted
	// at the repo layer). ClientID is unused for service accounts but we
	// surface it in admin for operator clarity.
	creds, err := infraintegration.ParseCreds([]byte(c.ClientSecret))
	if err != nil {
		return nil, err
	}
	return creds, nil
}

func (uc *SyncToGoogleUseCase) buildEvent(b booking.Booking, remoteID string) infraintegration.GoogleEvent {
	var ev infraintegration.GoogleEvent
	ev.ID = remoteID
	ev.Summary = "FSD booking"
	if b.MeetingURL != "" {
		ev.Description = "Meeting: " + b.MeetingURL
	}
	ev.Start.DateTime = b.StartTime.Format(time.RFC3339)
	ev.End.DateTime = b.EndTime.Format(time.RFC3339)
	ev.Status = "confirmed"
	return ev
}

// helper for tests; the production code path uses uc.creds directly.
func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
