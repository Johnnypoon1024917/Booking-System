package handlers

import (
	"context"
	"net/http"
	"sync"
	"time"

	"fsd-mrbs/src/infrastructure/external"
)

// WeatherHandler exposes the current HK Observatory weather (temperature +
// active signals) for the dashboard widget. Responses are cached for a few
// minutes so repeated dashboard loads don't hammer the HKO feed.
type WeatherHandler struct {
	hko *external.HKOClient

	mu       sync.Mutex
	cached   external.WeatherReport
	cachedAt time.Time
	ttl      time.Duration
}

func NewWeatherHandler(hko *external.HKOClient) *WeatherHandler {
	return &WeatherHandler{hko: hko, ttl: 5 * time.Minute}
}

func (h *WeatherHandler) Current(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	fresh := time.Since(h.cachedAt) < h.ttl && !h.cachedAt.IsZero()
	cached := h.cached
	h.mu.Unlock()

	if fresh {
		writeJSON(w, http.StatusOK, cached)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 9*time.Second)
	defer cancel()
	rep, err := h.hko.CurrentWeather(ctx)
	if err != nil {
		// Serve stale data rather than failing the widget.
		if !h.cachedAt.IsZero() {
			writeJSON(w, http.StatusOK, cached)
			return
		}
		writeJSON(w, http.StatusOK, external.WeatherReport{Signals: []external.WeatherSignal{}})
		return
	}
	h.mu.Lock()
	h.cached = rep
	h.cachedAt = time.Now()
	h.mu.Unlock()
	writeJSON(w, http.StatusOK, rep)
}
