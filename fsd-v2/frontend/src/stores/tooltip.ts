import { create } from 'zustand';

// Lightweight global tooltip. A single floating layer (TooltipLayer) reads this
// store and renders one element that follows the cursor, so any trigger only
// needs to spread `tip(text)`'s handlers — no wrapper DOM, which is what lets it
// work on absolutely-positioned blocks (calendar free/busy, schedule context)
// where a wrapping element would break the layout. Instant on hover, unlike the
// ~1.5s native `title` delay the audit flagged.
interface TooltipState {
  text: string;
  x: number;
  y: number;
  show: boolean;
  set: (text: string, x: number, y: number) => void;
  hide: () => void;
}

export const useTooltip = create<TooltipState>((set) => ({
  text: '',
  x: 0,
  y: 0,
  show: false,
  set: (text, x, y) => set({ text, x, y, show: !!text }),
  hide: () => set({ show: false }),
}));

// Spread onto any element to give it an instant, cursor-tracking tooltip:
//   <div {...tip('09:00–10:00 · Standup')} />
// Empty/blank text is a no-op (returns nothing to show), so callers can pass a
// possibly-empty string without guarding.
export function tip(text: string) {
  if (!text) return {};
  const move = (e: { clientX: number; clientY: number }) =>
    useTooltip.getState().set(text, e.clientX, e.clientY);
  return {
    onMouseEnter: move,
    onMouseMove: move,
    onMouseLeave: () => useTooltip.getState().hide(),
  };
}
