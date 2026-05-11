package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// Microsoft Graph caps subscription lifetimes at ~70.5h for mailbox events.
// Renew comfortably ahead — every 12h gives the renewer plenty of margin.
const (
	maxSubscriptionLifetime = 4200 * time.Minute  // < 4230 minute API ceiling
	renewBeforeExpiry       = 12 * time.Hour
)

// Subscription describes a Graph change-notification subscription.
// Returned from CreateSubscription so the caller can persist the id +
// expiration + client_state for later renewal/validation.
type Subscription struct {
	ID                 string    `json:"id"`
	Resource           string    `json:"resource"`
	ChangeType         string    `json:"changeType"`
	NotificationURL    string    `json:"notificationUrl"`
	ExpirationDateTime time.Time `json:"-"`
	RawExpiration      string    `json:"expirationDateTime"`
	ClientState        string    `json:"clientState"`
}

// CreateSubscription opens a change-notifications subscription on a room
// mailbox. We listen for create / update / delete on the user's events
// collection so we mirror everything the user does in Outlook.
//
// notificationURL must be HTTPS-reachable from Microsoft (a public
// hostname or an https-tunneled local). Microsoft will POST a validation
// handshake to that URL synchronously during this call — make sure the
// /api/v1/graph/notifications handler is wired before calling.
func (g *GraphClient) CreateSubscription(ctx context.Context, token, mailboxUPN, notificationURL, clientState string) (*Subscription, error) {
	body := map[string]any{
		"changeType":         "created,updated,deleted",
		"notificationUrl":    notificationURL,
		"resource":           fmt.Sprintf("users/%s/events", mailboxUPN),
		"expirationDateTime": time.Now().Add(maxSubscriptionLifetime).UTC().Format(time.RFC3339),
		"clientState":        clientState,
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, graphBase+"/subscriptions", bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("create subscription %d: %s", resp.StatusCode, rb)
	}
	var s Subscription
	if err := json.Unmarshal(rb, &s); err != nil {
		return nil, err
	}
	if s.RawExpiration != "" {
		if t, e := time.Parse(time.RFC3339, s.RawExpiration); e == nil {
			s.ExpirationDateTime = t
		}
	}
	return &s, nil
}

// RenewSubscription PATCHes a fresh expiration onto an existing subscription.
func (g *GraphClient) RenewSubscription(ctx context.Context, token, subscriptionID string) (time.Time, error) {
	body := map[string]any{
		"expirationDateTime": time.Now().Add(maxSubscriptionLifetime).UTC().Format(time.RFC3339),
	}
	raw, _ := json.Marshal(body)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPatch,
		graphBase+"/subscriptions/"+url.PathEscape(subscriptionID), bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return time.Time{}, err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 400 {
		return time.Time{}, fmt.Errorf("renew subscription %d: %s", resp.StatusCode, rb)
	}
	var out struct {
		ExpirationDateTime string `json:"expirationDateTime"`
	}
	_ = json.Unmarshal(rb, &out)
	t, _ := time.Parse(time.RFC3339, out.ExpirationDateTime)
	return t, nil
}

// DeleteSubscription removes a subscription (called on mailbox unmap or
// integration disconnect).
func (g *GraphClient) DeleteSubscription(ctx context.Context, token, subscriptionID string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete,
		graphBase+"/subscriptions/"+url.PathEscape(subscriptionID), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 || resp.StatusCode == 410 {
		return nil
	}
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("delete subscription %d: %s", resp.StatusCode, rb)
	}
	return nil
}

// FetchEvent retrieves a single event by id. Used by the notification
// webhook to reconcile an inbound change.
func (g *GraphClient) FetchEvent(ctx context.Context, token, mailboxUPN, eventID string) (*EventDetails, error) {
	u := fmt.Sprintf("%s/users/%s/events/%s", graphBase, url.PathEscape(mailboxUPN), url.PathEscape(eventID))
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := g.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, ErrNotFound
	}
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode >= 400 {
		return nil, fmt.Errorf("fetch event %d: %s", resp.StatusCode, rb)
	}
	var d EventDetails
	if err := json.Unmarshal(rb, &d); err != nil {
		return nil, err
	}
	return &d, nil
}

// EventDetails is the larger event projection we read back. We don't
// model every Graph field — only what the reconciler needs.
type EventDetails struct {
	ID         string `json:"id"`
	ICalUID    string `json:"iCalUId"`
	Subject    string `json:"subject"`
	IsCancelled bool  `json:"isCancelled"`
	Start      EventDateTime `json:"start"`
	End        EventDateTime `json:"end"`
	Organizer  *Organizer    `json:"organizer"`
	Body       struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
	Location struct {
		DisplayName string `json:"displayName"`
	} `json:"location"`
	// SingleValueExtendedProperties carries our application's tag, used
	// to detect "we created this — don't loop it back into a booking".
	SingleValueExtendedProperties []SingleValueExtendedProperty `json:"singleValueExtendedProperties"`
}

// SingleValueExtendedProperty is Graph's mechanism for app-defined props.
// We use propertyTag "String 0x3001" with name "FSDBookingId" to mark
// events we authored.
type SingleValueExtendedProperty struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

// ErrSubscriptionRenewSkipped is returned by reconcilers when the event
// matches a booking we already wrote — i.e. it's our own write looping back.
var ErrSubscriptionRenewSkipped = errors.New("subscription does not need renewal yet")

// NeedsRenewal reports whether a subscription should be renewed now.
func NeedsRenewal(expiresAt time.Time) bool {
	return time.Until(expiresAt) <= renewBeforeExpiry
}
