import { create } from 'zustand';

// Toast store — direct port of v1's stores/toast.js. Each toast
// auto-dismisses after its configured duration; ToastHost listens to
// `items` and animates them in/out. The numeric counter survives the
// life of the SPA, which keeps React keys stable across pushes.
export type ToastKind = 'success' | 'info' | 'warning' | 'error';

// An optional inline action — used for the Gmail-style "Undo" affordance on
// calendar moves/resizes so a fluid drag isn't interrupted by a blocking
// confirm. Clicking it runs `onClick` and dismisses the toast.
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  kind: ToastKind;
  duration: number;
  createdAt: number;
  action?: ToastAction;
}

interface PushArgs {
  title: string;
  description?: string;
  kind?: ToastKind;
  duration?: number;
  action?: ToastAction;
}

interface ToastState {
  items: ToastItem[];
  push: (args: PushArgs) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string) => number;
  info: (title: string, description?: string) => number;
  warning: (title: string, description?: string) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToast = create<ToastState>((set, get) => ({
  items: [],
  push: ({ title, description, kind = 'info', duration = 4500, action }) => {
    const id = nextId++;
    const item: ToastItem = { id, title, description, kind, duration, createdAt: Date.now(), action };
    set((s) => ({ items: [...s.items, item] }));
    if (duration > 0) {
      setTimeout(() => get().dismiss(id), duration);
    }
    return id;
  },
  success: (title, description) => get().push({ title, description, kind: 'success' }),
  error:   (title, description) => get().push({ title, description, kind: 'error', duration: 6000 }),
  info:    (title, description) => get().push({ title, description, kind: 'info' }),
  warning: (title, description) => get().push({ title, description, kind: 'warning' }),
  dismiss: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
