import { create } from 'zustand';

// Custom system dialogs — replaces the native window.confirm / window.prompt /
// window.alert (the ugly "localhost:5173 says" chrome popups) with in-app
// modals that match the design system. Use the imperative helpers below from
// event handlers; they return Promises that mirror the native semantics:
//   confirmDialog → boolean   (true = confirmed)
//   promptDialog  → string|null (null = cancelled, like window.prompt)
//   alertDialog   → void       (resolves when dismissed)

type DialogKind = 'confirm' | 'prompt' | 'alert';
type Tone = 'default' | 'danger';

export interface DialogRequest {
  kind: DialogKind;
  title: string;
  message?: string;
  tone?: Tone;
  confirmText?: string;
  cancelText?: string;
  // prompt-only
  inputLabel?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;     // disable confirm until non-blank
  multiline?: boolean;
}

interface ActiveDialog extends DialogRequest {
  id: number;
  resolve: (value: boolean | string | null) => void;
}

interface DialogState {
  active: ActiveDialog | null;
  open: (req: DialogRequest) => Promise<boolean | string | null>;
  close: (value: boolean | string | null) => void;
}

let seq = 1;

export const useConfirm = create<DialogState>((set, get) => ({
  active: null,
  open: (req) =>
    new Promise((resolve) => {
      set({ active: { ...req, id: seq++, resolve } });
    }),
  close: (value) => {
    const a = get().active;
    if (!a) return;
    a.resolve(value);
    set({ active: null });
  },
}));

// ---- Imperative helpers (call from anywhere, no hook required) ----

export function confirmDialog(opts: {
  title: string;
  message?: string;
  tone?: Tone;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  return useConfirm.getState().open({ kind: 'confirm', ...opts }) as Promise<boolean>;
}

export function promptDialog(opts: {
  title: string;
  message?: string;
  inputLabel?: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  multiline?: boolean;
  confirmText?: string;
  cancelText?: string;
  tone?: Tone;
}): Promise<string | null> {
  return useConfirm.getState().open({ kind: 'prompt', ...opts }) as Promise<string | null>;
}

export function alertDialog(opts: {
  title: string;
  message?: string;
  confirmText?: string;
  tone?: Tone;
}): Promise<void> {
  return useConfirm.getState().open({ kind: 'alert', ...opts }).then(() => undefined);
}
