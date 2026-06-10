// realtime store — last-50 ring buffer of SSE events. Any page that
// wants a "recent activity" feed reads `events` here; the dedicated
// useRealtime hook is responsible for actually opening the EventSource.
//
// Decoupling the buffer from the subscription means switching tabs
// doesn't drop history, and pages that mount after the connection is
// open still see the recent context.
import { create } from 'zustand';

export interface RealtimeEvent {
  // Monotonic sequence id from the backend, surfaced as the SSE event id. Used
  // to dedupe the overlap between a reconnect's replayed tail and the live
  // stream so an event isn't applied twice.
  id?: string;
  type: string;
  tenantId?: string;
  bookingId?: string;
  resourceId?: string;
  userId?: string;
  payload?: Record<string, any>;
  at?: string;
}

const MAX_EVENTS = 50;

interface RealtimeState {
  events: RealtimeEvent[];
  lastEvent: RealtimeEvent | null;
  // Bounded set of recently-seen event ids, for deduping the overlap between a
  // reconnect's replayed tail and the live stream. A *set* (not a high-water
  // mark) so out-of-order live delivery across nodes, or a Redis seq counter
  // reset, can't permanently silence the stream.
  seenIds: Set<string>;
  // Whether the SSE stream is currently open. Lives in the store (not the
  // hook) so every consumer — the calendar grid, the notification bell, and
  // the global offline banner — reads one shared truth instead of each
  // tracking its own EventSource state.
  connected: boolean;
  // Bumped each time the stream is re-established after a drop. Data views
  // watch it to force a full refetch on reconnect — closing the staleness gap
  // for anything that happened while offline (and the ms-wide window between
  // the server's replay snapshot and the live subscription).
  reconnectNonce: number;
  push: (ev: RealtimeEvent) => void;
  setConnected: (connected: boolean) => void;
  markReconnect: () => void;
  clear: () => void;
}

// Cap on the dedupe set: a couple of buffer-replays' worth of ids. Older ids
// fall out, which is harmless — they're long past being re-delivered.
const MAX_SEEN_IDS = 500;

export const useRealtimeStore = create<RealtimeState>((set) => ({
  events: [],
  lastEvent: null,
  seenIds: new Set<string>(),
  // Optimistic: assume connected until the first error so we don't flash the
  // offline banner during the initial handshake on a healthy connection.
  connected: true,
  reconnectNonce: 0,
  push: (ev) =>
    set((s) => {
      // Dedupe exact ids: a reconnect replays the missed tail, which can briefly
      // overlap the live stream. Skip an id we've already applied — but only
      // exact repeats, so out-of-order delivery or an id-space reset can't
      // silence the stream the way a >= high-water comparison would.
      if (ev.id && s.seenIds.has(ev.id)) return s;
      let seenIds = s.seenIds;
      if (ev.id) {
        seenIds = new Set(s.seenIds);
        seenIds.add(ev.id);
        if (seenIds.size > MAX_SEEN_IDS) {
          // Drop the oldest (insertion-ordered) ids back down to the cap.
          const trim = seenIds.size - MAX_SEEN_IDS;
          const it = seenIds.values();
          for (let i = 0; i < trim; i++) seenIds.delete(it.next().value as string);
        }
      }
      // Newest-first; slice to cap memory. 50 covers the dashboard
      // "recent activity" widget without growing unboundedly on a
      // long-lived tab.
      const next = [ev, ...s.events].slice(0, MAX_EVENTS);
      return { events: next, lastEvent: ev, seenIds };
    }),
  setConnected: (connected) => set({ connected }),
  markReconnect: () => set((s) => ({ reconnectNonce: s.reconnectNonce + 1 })),
  clear: () => set({ events: [], lastEvent: null, seenIds: new Set<string>() }),
}));

export default useRealtimeStore;
