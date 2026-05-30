import { ReactNode, useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// Selector for the elements that can hold keyboard focus inside the dialog.
const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Accessible overlay modal: labelled dialog with a focus trap. Escape and
// backdrop-click close; content clicks are swallowed so a click inside a form
// doesn't dismiss it. On open we move focus into the dialog and trap Tab
// inside it; on close we restore focus to whatever was focused before, so
// keyboard and screen-reader users never end up stranded behind the modal
// (previously Tab walked straight out into the page underneath).
export function Modal({ title, onClose, children, footer }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    // Remember the trigger so we can hand focus back when the modal closes.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the dialog: first focusable element, else the dialog
    // container (which is tabindex=-1 so it can receive programmatic focus).
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab' || !dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) { e.preventDefault(); return; }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap around the ends so Tab/Shift+Tab can never escape the dialog.
      if (e.shiftKey && (active === firstEl || !dialog.contains(active))) {
        e.preventDefault(); lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault(); firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      // Restore focus to the trigger element on unmount.
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h3 id={titleId}>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="close"><X size={16}/></button>
        </header>
        <section>{children}</section>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}
