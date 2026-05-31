// realtime store — last-50 ring buffer of SSE events. Any page that
// wants a "recent activity" feed reads `events` here; the dedicated
// useRealtime hook is responsible for actually opening the EventSource.
//
// Decoupling the buffer from the subscription means switching tabs
// doesn't drop history, and pages that mount after the connection is
// open still see the recent context.
import { create } from 'zustand';

export interface RealtimeEvent {
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
  // Whether the SSE stream is currently open. Lives in the store (not the
  // hook) so every consumer — the calendar grid, the notification bell, and
  // the global offline banner — reads one shared truth instead of each
  // tracking its own EventSource state.
  connected: boolean;
  push: (ev: RealtimeEvent) => void;
  setConnected: (connected: boolean) => void;
  clear: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  events: [],
  lastEvent: null,
  // Optimistic: assume connected until the first error so we don't flash the
  // offline banner during the initial handshake on a healthy connection.
  connected: true,
  push: (ev) =>
    set((s) => {
      // Newest-first; slice to cap memory. 50 covers the dashboard
      // "recent activity" widget without growing unboundedly on a
      // long-lived tab.
      const next = [ev, ...s.events].slice(0, MAX_EVENTS);
      return { events: next, lastEvent: ev };
    }),
  setConnected: (connected) => set({ connected }),
  clear: () => set({ events: [], lastEvent: null }),
}));

export default useRealtimeStore;
