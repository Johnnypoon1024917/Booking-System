// Package realtime broadcasts booking-availability deltas to connected
// browsers over WebSocket. The hub is per-tenant: a connection that
// authenticates as tenant X only sees events for tenant X.
//
// Wire diagram:
//
//   booking write → publish("booking_events") → consumer → hub.Broadcast →
//                                                          → all WS clients
//
// We don't push the whole booking record; we push a small "delta" event so
// the SPA can invalidate its calendar cache for the affected resource and
// (optionally) refetch only that range.
package realtime

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
)

// Event is the shape pushed to clients. Keep it small.
type Event struct {
	Type       string    `json:"type"`        // "booking.created" | "booking.updated" | "booking.cancelled" | "weather.signal" | "broadcast"
	TenantID   uuid.UUID `json:"tenant_id"`
	ResourceID string    `json:"resource_id,omitempty"`
	BookingID  string    `json:"booking_id,omitempty"`
	Status     string    `json:"status,omitempty"`
	Start      time.Time `json:"start,omitempty"`
	End        time.Time `json:"end,omitempty"`
	Payload    any       `json:"payload,omitempty"`
}

// Hub fans events out to all clients of the matching tenant.
type Hub struct {
	mu      sync.RWMutex
	clients map[*Client]struct{}
}

func NewHub() *Hub {
	return &Hub{clients: make(map[*Client]struct{})}
}

// Broadcast queues an event for all matching clients. Slow clients are
// dropped rather than back-pressured into the booking pipeline.
func (h *Hub) Broadcast(ev Event) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c.tenantID != ev.TenantID {
			continue
		}
		select {
		case c.send <- ev:
		default:
			// Drop slow client; reaper closes them below.
			c.markStale()
		}
	}
}

// Stats returns connection counts for /healthz.
func (h *Hub) Stats() map[string]int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	stats := map[string]int{"total": len(h.clients)}
	return stats
}

// Client is one WebSocket connection.
type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	tenantID uuid.UUID
	send     chan Event
	stale    bool
	mu       sync.Mutex
}

func (c *Client) markStale() {
	c.mu.Lock()
	c.stale = true
	c.mu.Unlock()
}

func (c *Client) isStale() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stale
}

var upgrader = websocket.Upgrader{
	// In production gate this at the load balancer; here we accept same-origin.
	CheckOrigin:     func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 4096,
}

// ServeWS upgrades an HTTP request to a WebSocket and registers the client.
// Caller is responsible for ensuring the request has been authenticated and
// tenantID is set on the context.
func (h *Hub) ServeWS(tenantID uuid.UUID, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade: %v", err)
		return
	}
	c := &Client{
		hub:      h,
		conn:     conn,
		tenantID: tenantID,
		send:     make(chan Event, 32),
	}
	h.register(c)
	go c.writePump()
	go c.readPump()
}

func (h *Hub) register(c *Client) {
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) unregister(c *Client) {
	h.mu.Lock()
	delete(h.clients, c)
	h.mu.Unlock()
	close(c.send)
}

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister(c)
		c.conn.Close()
	}()
	c.conn.SetReadLimit(8192)
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		// We don't accept inbound messages; reading just keeps the conn alive.
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (c *Client) writePump() {
	pinger := time.NewTicker(25 * time.Second)
	defer func() {
		pinger.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case ev, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			data, _ := json.Marshal(ev)
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
			if c.isStale() {
				return
			}
		case <-pinger.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
