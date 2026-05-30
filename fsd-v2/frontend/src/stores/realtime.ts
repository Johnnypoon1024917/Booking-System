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
  push: (ev: RealtimeEvent) => void;
  clear: () => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  events: [],
  lastEvent: null,
  push: (ev) =>
    set((s) => {
      // Newest-first; slice to cap memory. 50 covers the dashboard
      // "recent activity" widget without growing unboundedly on a
      // long-lived tab.
      const next = [ev, ...s.events].slice(0, MAX_EVENTS);
      return { events: next, lastEvent: ev };
    }),
  clear: () => set({ events: [], lastEvent: null }),
}));

export default useRealtimeStore;
