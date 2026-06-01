import { CheckCircle2, Info, AlertTriangle, XCircle, X, LucideIcon } from 'lucide-react';
import { useToast, ToastKind } from '../stores/toast';

const ICONS: Record<ToastKind, LucideIcon> = {
  success: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  error: XCircle,
};

// Fixed top-right toast stack. Reads directly from the zustand store so
// any module (`useToast.getState().success(...)`) can push without
// holding a ref to the host. The thin bar at the bottom of each toast
// is a CSS animation tied to the toast's duration — purely cosmetic, no
// JS timer needed beyond the auto-dismiss the store already handles.
export function ToastHost() {
  const items = useToast((s) => s.items);
  const dismiss = useToast((s) => s.dismiss);

  return (
    <div className="toast-host" role="region" aria-label="Notifications">
      {items.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`} role="status">
            <Icon size={18} className="toast-icon" />
            <div className="toast-body">
              <b>{t.title}</b>
              {t.description && <p>{t.description}</p>}
            </div>
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { t.action!.onClick(); dismiss(t.id); }}
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
            {t.duration > 0 && (
              <span
                className="toast-progress"
                style={{ animationDuration: `${t.duration}ms` }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
