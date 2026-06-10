import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  id: string;
  tenantId: string;
  tenantSlug?: string;
  username: string;
  role: string;
  grade?: string;
  regionAccess?: string[];
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  // The caller's effective permission keys (e.g. 'report.view'), hydrated from
  // /auth/me on boot. `null` = not yet loaded (don't enforce permission-gated
  // routes until known, to avoid a false redirect on first paint). The backend
  // guards are the real enforcement; this only drives what the UI shows.
  permissions: string[] | null;
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  isAdmin: () => boolean;
  setPermissions: (permissions: string[]) => void;
  hasPerm: (permission: string) => boolean;
}

// localStorage-backed so a page refresh doesn't drop the session and
// the JWT survives across tabs of the same origin.
export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      permissions: null,
      // A fresh login predates the /auth/me hydration, so clear any stale
      // permission set — App re-fetches it for the new user immediately.
      login: (token, user) => set({ token, user, permissions: null }),
      logout: () => set({ token: null, user: null, permissions: null }),
      isAdmin: () =>
        ['System Admin', 'Security Admin', 'Room Admin', 'Secretary']
          .includes(get().user?.role ?? ''),
      setPermissions: (permissions) => set({ permissions }),
      hasPerm: (permission) => (get().permissions ?? []).includes(permission),
    }),
    {
      name: 'fsd_auth',
      // Persist permissions too so a reload gates the UI correctly before the
      // /auth/me round-trip completes (the value is still re-validated on boot).
      partialize: (s) => ({ token: s.token, user: s.user, permissions: s.permissions }),
    },
  ),
);

// Side-effect bridge: keep the bare JWT in `fsd_jwt` so the axios
// interceptor doesn't need to know about the zustand store.
useAuth.subscribe((s) => {
  if (s.token) localStorage.setItem('fsd_jwt', s.token);
  else localStorage.removeItem('fsd_jwt');
  if (s.user) localStorage.setItem('fsd_user', JSON.stringify(s.user));
  else localStorage.removeItem('fsd_user');
});
