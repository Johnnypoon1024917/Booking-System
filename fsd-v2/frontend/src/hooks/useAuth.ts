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
  login: (token: string, user: AuthUser) => void;
  logout: () => void;
  isAdmin: () => boolean;
}

// localStorage-backed so a page refresh doesn't drop the session and
// the JWT survives across tabs of the same origin.
export const useAuth = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      login: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
      isAdmin: () =>
        ['System Admin', 'Security Admin', 'Room Admin', 'Secretary']
          .includes(get().user?.role ?? ''),
    }),
    { name: 'fsd_auth', partialize: (s) => ({ token: s.token, user: s.user }) },
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
