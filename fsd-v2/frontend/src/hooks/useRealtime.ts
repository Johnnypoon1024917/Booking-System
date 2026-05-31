// useRealtime — opens an SSE connection to /api/v1/realtime, feeds every
// event into the realtime zustand store, and auto-reconnects on close.
//
// EventSource can't set custom headers, so we pass the JWT via the
// query-param `?token=` fallback exactly the way v1's SPA does. The
// backend's realtime controller accepts either the cookie/header form
// (when behind a session proxy) or this query-param.
//
// The connection closes automatically when the auth store reports the
// user has logged out, so logout doesn't leave a dangling stream.

import { useEffect, useRef } from 'react';
import { useRealtimeStore, RealtimeEvent } from '../stores/realtime';
import { useAuth } from './useAuth';

const ENDPOINT = '/api/v1/realtime';
const RECONNECT_MS = 3000;

export interface UseRealtimeOptions {
  onEvent?: (ev: RealtimeEvent) => void;
  // Disable reconnect when the consumer wants strict one-shot behaviour
  // (e.g. unit tests). Defaults to true for normal page use.
  autoReconnect?: boolean;
}

export function useRealtime(options: UseRealtimeOptions = {}) {
  const { onEvent, autoReconnect = true } = options;
  const push = useRealtimeStore((s) => s.push);
  const events = useRealtimeStore((s) => s.events);
  const lastEvent = useRealtimeStore((s) => s.lastEvent);
  const isConnected = useRealtimeStore((s) => s.connected);
  const setConnected = useRealtimeStore((s) => s.setConnected);
  const token = useAuth((s) => s.token);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!token) {
      // Logged out: tear down any existing stream.
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      return;
    }
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const open = () => {
      if (cancelled) return;
      const jwt = localStorage.getItem('fsd_jwt') || token;
      const url = `${ENDPOINT}?token=${encodeURIComponent(jwt)}`;
      const es = new EventSource(url, { withCredentials: true });
      esRef.current = es;
      // Stream is live — clear any offline banner. onopen fires once the
      // server accepts the connection (after a successful reconnect too).
      es.onopen = () => { if (!cancelled) setConnected(true); };
      es.onmessage = (msg) => {
        try {
          const parsed: RealtimeEvent = JSON.parse(msg.data);
          push(parsed);
          if (onEvent) onEvent(parsed);
        } catch {
          // Ignore non-JSON heartbeats.
        }
      };
      es.onerror = () => {
        es.close();
        esRef.current = null;
        // Surface the drop immediately so the UI can warn the user the data
        // may be stale; onopen flips it back when the retry succeeds.
        if (!cancelled) setConnected(false);
        if (!cancelled && autoReconnect) {
          reconnectTimer = setTimeout(open, RECONNECT_MS);
        }
      };
    };
    open();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
    };
    // onEvent intentionally not in the dep list — re-creating the
    // EventSource every time the callback identity changes would churn
    // connections. Consumers that need to swap callbacks should re-mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, autoReconnect]);

  return { events, lastEvent, isConnected };
}

export default useRealtime;
