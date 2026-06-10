import { create } from 'zustand';

// Theme store — tenant brand colours only. Dark mode has been removed; the
// app is light-only. Brand colours are written to the documentElement as
// CSS custom properties so every component picks them up without prop
// drilling, and persisted so they survive reloads.
interface ThemeState {
  brandPrimary: string;
  brandSecondary: string;
  brandAccent: string;
  // Any arg left undefined keeps its current value, so callers can update a
  // subset (the tenant doc always supplies all three).
  setBrand: (primary?: string, secondary?: string, accent?: string) => void;
  apply: () => void;
}

const BRAND_KEY = 'fsd_brand';

function loadBrand(): { primary: string; secondary: string; accent: string } {
  try {
    const raw = localStorage.getItem(BRAND_KEY);
    if (raw) {
      const b = JSON.parse(raw);
      return { primary: b.primary, secondary: b.secondary, accent: b.accent ?? '#f7b500' };
    }
  } catch { /* ignore */ }
  return { primary: '#002147', secondary: '#3498db', accent: '#f7b500' };
}

function applyToDom(primary: string, secondary: string, accent: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.style.setProperty('--brand-primary', primary);
  document.documentElement.style.setProperty('--brand-secondary', secondary);
  // Accent was previously never repainted — branding saves that changed only the
  // accent appeared to "do nothing" until a reload (QA #5).
  document.documentElement.style.setProperty('--brand-accent', accent);
}

const initialBrand = loadBrand();

export const useTheme = create<ThemeState>((set, get) => ({
  brandPrimary: initialBrand.primary,
  brandSecondary: initialBrand.secondary,
  brandAccent: initialBrand.accent,
  setBrand: (primary, secondary, accent) => {
    const p = primary || get().brandPrimary;
    const s = secondary || get().brandSecondary;
    const a = accent || get().brandAccent;
    set({ brandPrimary: p, brandSecondary: s, brandAccent: a });
    try { localStorage.setItem(BRAND_KEY, JSON.stringify({ primary: p, secondary: s, accent: a })); } catch { /* ignore */ }
    applyToDom(p, s, a);
  },
  apply: () => applyToDom(get().brandPrimary, get().brandSecondary, get().brandAccent),
}));

// Apply once at import so first render already has the right palette.
applyToDom(initialBrand.primary, initialBrand.secondary, initialBrand.accent);
