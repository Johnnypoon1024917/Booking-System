package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// ProactiveBotClient sends Bot Framework messages to a Teams user without
// the user having initiated the conversation. We use a stored
// ConversationReference (serviceUrl, conversationId, botId) plus an app
// access token from Microsoft Identity Platform.
//
// Auth: the bot's app credentials use the OAuth2 client_credentials flow
// against `https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token`
// with scope `https://api.botframework.com/.default`.
type ProactiveBotClient struct {
	http   *http.Client
	mu     sync.Mutex
	token  string
	expiry time.Time
}

func NewProactiveBotClient() *ProactiveBotClient {
	return &ProactiveBotClient{http: &http.Client{Timeout: 10 * time.Second}}
}

// Token returns a cached or fresh app token.
func (c *ProactiveBotClient) Token(ctx context.Context, appID, appPassword string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.token != "" && time.Until(c.expiry) > time.Minute {
		return c.token, nil
	}
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("client_id", appID)
	form.Set("client_secret", appPassword)
	form.Set("scope", "https://api.botframework.com/.default")

	req, _ := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
		bytes.NewBufferString(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("bot token %d: %s", resp.StatusCode, body)
	}
	var out struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", err
	}
	c.token = out.AccessToken
	c.expiry = time.Now().Add(time.Duration(out.ExpiresIn) * time.Second)
	return c.token, nil
}

// Send posts an activity to the conversation reference. text appears as
// a plain message; if cardJSON is non-empty it's attached as an
// adaptive card instead.
func (c *ProactiveBotClient) Send(ctx context.Context, appID, appPassword, serviceURL, conversationID, text string, card map[string]any) error {
	tok, err := c.Token(ctx, appID, appPassword)
	if err != nil {
		return err
	}
	activity := map[string]any{
		"type":    "message",
		"text":    text,
		"locale":  "en-US",
	}
	if card != nil {
		activity["attachments"] = []map[string]any{
			{"contentType": "application/vnd.microsoft.card.adaptive", "content": card},
		}
	}
	raw, _ := json.Marshal(activity)
	endpoint := serviceURL + "v3/conversations/" + url.PathEscape(conversationID) + "/activities"
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(raw))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("send activity %d: %s", resp.StatusCode, body)
	}
	return nil
}
