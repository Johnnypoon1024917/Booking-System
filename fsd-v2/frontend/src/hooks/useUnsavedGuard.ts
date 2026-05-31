// useUnsavedGuard — call from any page with in-progress, unsaved edits to
// arm two layers of leave-protection while `dirty` is true:
//
//   1. The browser's native beforeunload prompt — covers tab close, refresh,
//      back-button, and navigation to an external URL. (The browser ignores
//      custom text here and only a native dialog can block an unload, so this
//      one path can't use the app's confirmDialog.)
//   2. The in-app nav guard store — the shell's sidebar/menu navigation reads
//      this and shows the app's confirmDialog before unmounting the page.
//
// Both clear automatically when `dirty` goes false or the page unmounts, so a
// saved/cancelled form never leaves a stale guard armed.
import { useEffect } from 'react';
import { useNavGuard } from '../stores/navGuard';

export function useUnsavedGuard(dirty: boolean, message?: string) {
  const setBlocker = useNavGuard((s) => s.setBlocker);

  useEffect(() => {
    setBlocker(dirty, message);
    return () => setBlocker(false);
  }, [dirty, message, setBlocker]);

  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

export default useUnsavedGuard;
