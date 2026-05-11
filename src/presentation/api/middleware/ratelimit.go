// Package middleware — rate-limit primitives used to protect the public
// surface (login, write endpoints) from abuse and brute-force attempts.
package middleware

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// RateLimiter is a tiny in-memory sliding-window limiter keyed by an
// arbitrary string (typically client IP, or "user:<username>"). For a
// single API replica this is sufficient; in a multi-replica deploy
// switch the backing store to Redis or use a sidecar limiter.
type RateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	limit    int
	window   time.Duration
	lockout  time.Duration
}

type bucket struct {
	hits        []time.Time
	lockedUntil time.Time
}

// NewRateLimiter returns a limiter that allows `limit` calls per `window`,
// then blocks the key for `lockout` after the threshold is exceeded.
func NewRateLimiter(limit int, window, lockout time.Duration) *RateLimiter {
	rl := &RateLimiter{
		buckets: make(map[string]*bucket),
		limit:   limit,
		window:  window,
		lockout: lockout,
	}
	go rl.gcLoop()
	return rl
}

// Allow records a hit for the key and returns whether it should proceed.
// retryAfter > 0 when blocked.
func (rl *RateLimiter) Allow(key string) (allowed bool, retryAfter time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	b, ok := rl.buckets[key]
	if !ok {
		b = &bucket{}
		rl.buckets[key] = b
	}
	if !b.lockedUntil.IsZero() && now.Before(b.lockedUntil) {
		return false, time.Until(b.lockedUntil)
	}
	// Trim hits older than the window.
	cutoff := now.Add(-rl.window)
	trimmed := b.hits[:0]
	for _, t := range b.hits {
		if t.After(cutoff) {
			trimmed = append(trimmed, t)
		}
	}
	b.hits = trimmed

	if len(b.hits) >= rl.limit {
		b.lockedUntil = now.Add(rl.lockout)
		return false, rl.lockout
	}
	b.hits = append(b.hits, now)
	return true, 0
}

// Reset clears any hits/lockout for a key (e.g. after a successful login).
func (rl *RateLimiter) Reset(key string) {
	rl.mu.Lock()
	delete(rl.buckets, key)
	rl.mu.Unlock()
}

func (rl *RateLimiter) gcLoop() {
	tick := time.NewTicker(rl.window)
	for range tick.C {
		rl.mu.Lock()
		now := time.Now()
		for k, b := range rl.buckets {
			cutoff := now.Add(-rl.window)
			if (b.lockedUntil.IsZero() || now.After(b.lockedUntil)) && len(b.hits) > 0 && b.hits[len(b.hits)-1].Before(cutoff) {
				delete(rl.buckets, k)
			}
		}
		rl.mu.Unlock()
	}
}

// Middleware wraps an http.Handler and enforces the limit using the request
// IP as the key. Use KeyByIPAndForm for login (IP+username) instead.
func (rl *RateLimiter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := "ip:" + clientIP(r)
		ok, retry := rl.Allow(key)
		if !ok {
			rl.respondLimited(w, retry)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// LoginGuard returns middleware tailored for /login. It rate-limits both
// by IP and by submitted username (X-Username header) so a single attacker
// IP can't grind through every account, and a distributed botnet can't
// brute-force a single account from many IPs.
func (rl *RateLimiter) LoginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		uname := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Username")))

		ipKey := "ip:" + ip
		if ok, retry := rl.Allow(ipKey); !ok {
			rl.respondLimited(w, retry)
			return
		}
		if uname != "" {
			userKey := "user:" + uname
			if ok, retry := rl.Allow(userKey); !ok {
				rl.respondLimited(w, retry)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func (rl *RateLimiter) respondLimited(w http.ResponseWriter, retry time.Duration) {
	if retry < time.Second {
		retry = time.Second
	}
	w.Header().Set("Retry-After", durationToSeconds(retry))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusTooManyRequests)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":   "rate limit exceeded",
		"retry_in_seconds": int(retry.Seconds()),
	})
}

func durationToSeconds(d time.Duration) string {
	s := int(d.Seconds())
	if s < 1 {
		s = 1
	}
	return itoa(s)
}

func itoa(n int) string {
	// avoid pulling in strconv just for this hot path
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func clientIP(r *http.Request) string {
	// Honor X-Forwarded-For when running behind a trusted proxy / LB.
	if v := r.Header.Get("X-Forwarded-For"); v != "" {
		if i := strings.Index(v, ","); i >= 0 {
			return strings.TrimSpace(v[:i])
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Real-IP"); v != "" {
		return v
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
