import { create } from 'zustand';

// Theme store — tenant brand colours only. Dark mode has been removed; the
// app is light-only. Brand colours are written to the documentElement as
// CSS custom properties so every component picks them up without prop
// drilling, and persisted so they survive reloads.
interface ThemeState {
  brandPrimary: string;
  brandSecondary: string;
  setBrand: (primary?: string, secondary?: string) => void;
  apply: () => void;
}

const BRAND_KEY = 'fsd_brand';

function loadBrand(): { primary: string; secondary: string } {
  try {
    const raw = localStorage.getItem(BRAND_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { primary: '#002147', secondary: '#3498db' };
}

function applyToDom(primary: string, secondary: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', 'light');
  document.documentElement.style.setProperty('--brand-primary', primary);
  document.documentElement.style.setProperty('--brand-secondary', secondary);
}

const initialBrand = loadBrand();

export const useTheme = create<ThemeState>((set, get) => ({
  brandPrimary: initialBrand.primary,
  brandSecondary: initialBrand.secondary,
  setBrand: (primary, secondary) => {
    const p = primary ?? get().brandPrimary;
    const s = secondary ?? get().brandSecondary;
    set({ brandPrimary: p, brandSecondary: s });
    try { localStorage.setItem(BRAND_KEY, JSON.stringify({ primary: p, secondary: s })); } catch { /* ignore */ }
    applyToDom(p, s);
  },
  apply: () => applyToDom(get().brandPrimary, get().brandSecondary),
}));

// Apply once at import so first render already has the right palette.
applyToDom(initialBrand.primary, initialBrand.secondary);
