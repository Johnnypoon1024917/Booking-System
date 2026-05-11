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
	"sync"
	"time"
)

// Microsoft Graph + Azure AD identity endpoints. Override via env for
// sovereign clouds (Government, China, etc).
const (
	azureTokenTemplate = "https://login.microsoftonline.com/%s/oauth2/v2.0/token"
	graphBase          = "https://graph.microsoft.com/v1.0"
	defaultScope       = "https://graph.microsoft.com/.default"
)

// GraphClient talks to Microsoft Graph using the OAuth2 client_credentials
// flow. Tokens are cached per (azure_tenant, client_id) tuple until they
// expire. The client is safe for concurrent use.
type GraphClient struct {
	http   *http.Client
	tokens sync.Map // map[string]*tokenEntry
}

type tokenEntry struct {
	value   string
	expires time.Time
}

func NewGraphClient(timeout time.Duration) *GraphClient {
	if timeout == 0 {
		timeout = 15 * time.Second
	}
	return &GraphClient{http: &http.Client{Timeout: timeout}}
}

// Token returns a non-expired access token for the given app credentials.
// Concurrent callers share the same in-flight refresh through sync.Map.
func (g *GraphClient) Token(ctx context.Context, azureTenantID, clientID, clientSecret string) (string, error) {
	key := azureTenantID + "/" + clientID
	if v, ok := g.tokens.Load(key); ok {
		t := v.(*tokenEntry)
		if time.Until(t.expires) > 60*time.Second {
			return t.value, nil
		}
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", clientID)
	form.Set("client_secret", clientSecret)
	form.Set("scope", defaultScope)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf(azureTokenTemplate, azureTenantID), bytes.NewBufferString(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := g.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("token endpoint returned %d: %s", resp.StatusCode, body)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Error       string `json:"error"`
		ErrorDesc   string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	if out.Error != "" {
		return "", fmt.Errorf("%s: %s", out.Error, out.ErrorDesc)
	}
	g.tokens.Store(key, &tokenEntry{
		value:   out.AccessToken,
		expires: time.Now().Add(time.Duration(out.ExpiresIn) * time.Second),
	})
	return out.AccessToken, nil
}

// TestConnection acquires a token then calls /v1.0/me equivalent — for
// app-only auth we use /v1.0/users/$top=1 since /me requires a user. A
// 200 response means the app's permissions are at least minimally valid.
func (g *GraphClient) TestConnection(ctx context.Context, azureTenantID, clientID, clientSecret string) error {
	tok, err := g.Token(ctx, azureTenantID, clientID, clientSecret)
	if err != nil {
		return fmt.Errorf("oauth: %w", err)
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, graphBase+"/users?$top=1", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("graph rejected token (%d): grant the app User.Read.All / Calendars.ReadWrite — %s", resp.StatusCode, body)
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("graph %d: %s", resp.StatusCode, body)
	}
	return nil
}

// Event is the minimal subset of the Microsoft Graph event resource we
// produce. Any extra fields are added before MarshalJSON.
type Event struct {
	Subject      string         `json:"subject"`
	Body         EventBody      `json:"body"`
	Start        EventDateTime  `json:"start"`
	End          EventDateTime  `json:"end"`
	Location     EventLocation  `json:"location"`
	Attendees    []Attendee     `json:"attendees,omitempty"`
	Organizer    *Organizer     `json:"organizer,omitempty"`
	IsOnlineMeeting bool        `json:"isOnlineMeeting,omitempty"`
}

type EventBody struct {
	ContentType string `json:"contentType"` // "HTML" or "Text"
	Content     string `json:"content"`
}
type EventDateTime struct {
	DateTime string `json:"dateTime"` // RFC3339 without TZ offset
	TimeZone string `json:"timeZone"` // IANA, e.g. "Asia/Hong_Kong"
}
type EventLocation struct {
	DisplayName string `json:"displayName"`
}
type Attendee struct {
	EmailAddress EmailAddress `json:"emailAddress"`
	Type         string       `json:"type"` // "required" / "optional"
}
type Organizer struct {
	EmailAddress EmailAddress `json:"emailAddress"`
}
type EmailAddress struct {
	Address string `json:"address"`
	Name    string `json:"name,omitempty"`
}

// CreateEvent posts a new event to /users/{mailbox}/events and returns the
// created event's id + iCalUId for later updates / cancellations.
func (g *GraphClient) CreateEvent(ctx context.Context, token, mailboxUPN string, ev Event) (id, icalUID string, err error) {
	body, _ := json.Marshal(ev)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		fmt.Sprintf("%s/users/%s/events", graphBase, url.PathEscape(mailboxUPN)), bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if resp.StatusCode >= 400 {
		return "", "", fmt.Errorf("create event %d: %s", resp.StatusCode, rb)
	}
	var out struct {
		ID       string `json:"id"`
		ICalUID  string `json:"iCalUId"`
	}
	if err := json.Unmarshal(rb, &out); err != nil {
		return "", "", err
	}
	return out.ID, out.ICalUID, nil
}

// UpdateEvent applies a PATCH to the existing event.
func (g *GraphClient) UpdateEvent(ctx context.Context, token, mailboxUPN, graphID string, ev Event) error {
	body, _ := json.Marshal(ev)
	req, _ := http.NewRequestWithContext(ctx, http.MethodPatch,
		fmt.Sprintf("%s/users/%s/events/%s", graphBase, url.PathEscape(mailboxUPN), url.PathEscape(graphID)),
		bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("update event %d: %s", resp.StatusCode, rb)
	}
	return nil
}

// CancelEvent issues a DELETE on the event so the room mailbox declines /
// removes the meeting.
func (g *GraphClient) CancelEvent(ctx context.Context, token, mailboxUPN, graphID string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodDelete,
		fmt.Sprintf("%s/users/%s/events/%s", graphBase, url.PathEscape(mailboxUPN), url.PathEscape(graphID)), nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := g.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil // already gone — idempotent
	}
	if resp.StatusCode >= 400 {
		rb, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("cancel event %d: %s", resp.StatusCode, rb)
	}
	return nil
}

// errMissingCredential is internal to this package.
var errMissingCredential = errors.New("microsoft credential not configured")
