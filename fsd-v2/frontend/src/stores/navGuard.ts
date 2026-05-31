// navGuard — a tiny global flag for "the page currently open has unsaved
// changes". The app mounts a declarative <BrowserRouter> (not a data router),
// so React Router's useBlocker/usePrompt are unavailable. Instead, dirty pages
// register here via useUnsavedGuard, and the shell's navigation entry points
// (sidebar links, user menu) consult this flag before letting a click unmount
// the page — giving us the same "Are you sure you want to leave?" guard a data
// router would provide.
import { create } from 'zustand';

interface NavGuardState {
  blocked: boolean;
  // Message shown in the leave-confirmation dialog. Page-specific so a 4-step
  // approval chain and a tenant-branding form can phrase the warning in their
  // own terms.
  message: string;
  setBlocker: (blocked: boolean, message?: string) => void;
}

export const useNavGuard = create<NavGuardState>((set) => ({
  blocked: false,
  message: '',
  setBlocker: (blocked, message = '') => set({ blocked, message }),
}));

export default useNavGuard;
