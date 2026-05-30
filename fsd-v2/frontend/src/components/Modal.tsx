import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

// Plain overlay modal — Escape closes, click on backdrop closes,
// content area click is swallowed so users don't accidentally close
// while interacting with form fields.
export function Modal({ title, onClose, children, footer }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h3>{title}</h3>
          <button className="iconbtn" onClick={onClose} aria-label="close"><X size={16}/></button>
        </header>
        <section>{children}</section>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}
