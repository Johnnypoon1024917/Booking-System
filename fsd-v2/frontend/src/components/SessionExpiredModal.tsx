import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useSession } from '../stores/session';
import { useT } from '../hooks/useT';

// In-place re-authentication dialog. Raised by the API client's 401 handler
// (via the session store) so an expired token can be refreshed *over* the
// current page — the route never unmounts, so a half-finished form keeps its
// React state. Closing the dialog (X / backdrop) is the escape hatch: it falls
// back to the full /login screen, remembering where to return (QA #4).
export function SessionExpiredModal() {
  const expired = useSession((s) => s.expired);
  const clear = useSession((s) => s.clear);
  const user = useAuth((s) => s.user);
  const login = useAuth((s) => s.login);
  const logout = useAuth((s) => s.logout);
  const { t } = useT();

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!expired) return null;

  const tenantSlug = user?.tenantSlug || 'default';
  const username = user?.username || '';

  // Hand off to the full login screen for flows that can't complete inline
  // (MFA, forced password change) or when the user dismisses the dialog.
  function toFullLogin() {
    try {
      sessionStorage.setItem('fsd_session_expired', '1');
      sessionStorage.setItem('fsd_return_to', location.pathname + location.search);
    } catch { /* storage may be unavailable (private mode) */ }
    clear();
    logout();
    location.href = '/login';
  }

  async function reauth(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.login(tenantSlug, username, password);
      if (r.mustChangePassword || r.requiresMfa) { toFullLogin(); return; }
      login(r.accessToken, r.user);
      clear();
      setPassword('');
    } catch (e: any) {
      setErr(e.displayMessage || t('login.loginFailed'));
    } finally { setBusy(false); }
  }

  return (
    <Modal title={t('login.sessionExpiredTitle')} onClose={toFullLogin}>
      <form onSubmit={reauth} style={{ display: 'grid', gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>{t('login.reauthHint')}</p>
        <label>{t('login.tenant')}
          <input value={tenantSlug} disabled />
        </label>
        <label>{t('login.username')}
          <input value={username} disabled />
        </label>
        <label>{t('login.password')}
          <input type="password" value={password} autoFocus
                 onChange={(e) => setPassword(e.target.value)} />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy || !password}>
          {busy && <Loader2 size={14} className="spin" />} {t('login.signIn')}
        </button>
      </form>
    </Modal>
  );
}
