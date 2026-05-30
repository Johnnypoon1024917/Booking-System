import { create } from 'zustand';
import { api } from '../api/client';
import { useTheme } from './theme';

// Tenant store — single source of truth for the customization document
// (branding, booking rules, custom fields, etc). Loaded once on app
// boot, callers can `reload()` after the System Admin saves changes.
// Mirrors v1's stores/tenant.js.
export interface Customization {
  // Loose shape — backend evolves, the SPA reads what it needs.
  [key: string]: any;
}

interface TenantState {
  customization: Customization | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  reload: () => Promise<void>;
}

async function fetchCustomization(set: (p: Partial<TenantState>) => void) {
  set({ loading: true, error: null });
  try {
    const c = await api.customization();
    set({ customization: c, loading: false });
    // Push brand colours from the tenant doc into the theme store so the
    // shell repaints immediately after a customization save.
    if (c?.brandPrimary || c?.brand_primary || c?.brandSecondary || c?.brand_secondary) {
      useTheme.getState().setBrand(
        c.brandPrimary || c.brand_primary,
        c.brandSecondary || c.brand_secondary,
      );
    }
  } catch (e: any) {
    set({ error: e?.displayMessage || e?.message || 'Failed to load', loading: false });
  }
}

export const useTenant = create<TenantState>((set) => ({
  customization: null,
  loading: false,
  error: null,
  load: () => fetchCustomization(set),
  reload: () => fetchCustomization(set),
}));
