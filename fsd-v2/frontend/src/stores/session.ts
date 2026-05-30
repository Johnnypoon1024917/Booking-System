import { create } from 'zustand';

// Session-expiry store. When the API client gets a 401 mid-session it raises
// `expired` here instead of hard-redirecting to /login. The App mounts a
// <SessionExpiredModal> that overlays the *current* page, so re-authenticating
// never unmounts the route — an in-progress multi-step form (e.g. a recurring
// booking on NewBooking step 3) keeps all its React state (QA #4).
interface SessionState {
  expired: boolean;
  markExpired: () => void;
  clear: () => void;
}

export const useSession = create<SessionState>((set) => ({
  expired: false,
  markExpired: () => set({ expired: true }),
  clear: () => set({ expired: false }),
}));
