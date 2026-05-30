import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

type Token = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt?: string; active: boolean };

// SCIM token admin. New tokens are shown in plaintext exactly once;
// after that only the prefix is visible. This matches v1's
// AdminScim.vue / scim_handler.go semantics.
export function AdminScim() {
  const { t } = useT();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('Azure AD provisioning');
  const [issued, setIssued] = useState<{ token: string; prefix: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try { setTokens(await api.scimTokens()); }
    catch (e: any) { setErr(e.displayMessage || 'load failed'); }
  }
  useEffect(() => { refresh(); }, []);

  async function issue() {
    setBusy(true); setErr(null);
    try {
      const r = await api.scimIssue(name);
      setIssued({ token: r.token, prefix: r.prefix });
      await refresh();
    } catch (e: any) {
      setErr(e.displayMessage || 'issue failed');
    } finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!(await confirmDialog({ title: t('scim.confirmRevoke'), tone: 'danger', confirmText: t('common.confirm'), cancelText: t('common.cancel') }))) return;
    await api.scimRevoke(id);
    await refresh();
  }

  return (
    <div className="admin-scim" style={{ display: 'grid', gap: 24, maxWidth: 900 }}>
      <section className="card">
        <h2>{t('scim.title')}</h2>
        <p className="muted">
          {t('scim.endpointBase')}: <code>{location.origin}/scim/v2</code>
          <br />
          {t('scim.idpHelp')}
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <label style={{ flex: 1 }}>{t('scim.tokenName')}
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy} onClick={issue}>{t('scim.issue')}</button>
        </div>
        {issued && (
          <div className="banner" style={{ marginTop: 12 }}>
            <strong>{t('scim.savedTitle')}.</strong>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{issued.token}</pre>
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </section>

      <section className="card">
        <h2>{t('scim.activeTokens')}</h2>
        {tokens.length === 0 ? (
          <p className="muted">{t('scim.noTokens')}</p>
        ) : (
          <table>
            <thead><tr><th>{t('scim.name')}</th><th>{t('scim.prefix')}</th><th>{t('scim.created')}</th><th>{t('scim.lastUsed')}</th><th></th></tr></thead>
            <tbody>
              {tokens.map((tok) => (
                <tr key={tok.id}>
                  <td>{tok.name}</td>
                  <td><code>{tok.prefix}…</code></td>
                  <td>{new Date(tok.createdAt).toLocaleString()}</td>
                  <td>{tok.lastUsedAt ? new Date(tok.lastUsedAt).toLocaleString() : '—'}</td>
                  <td><button className="btn ghost" onClick={() => revoke(tok.id)}>{t('scim.revoke')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
