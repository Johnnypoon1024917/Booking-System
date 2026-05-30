import { useEffect, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

type Token = { id: string; name: string; prefix: string; createdAt: string; lastUsedAt?: string; expiresAt?: string; active: boolean };

// SCIM token admin. New tokens are shown in plaintext exactly once;
// after that only the prefix is visible. This matches v1's
// AdminScim.vue / scim_handler.go semantics.
export function AdminScim() {
  const { t } = useT();
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('Azure AD provisioning');
  // NIST 800-53 (IA-5) forbids non-expiring credentials — every token is
  // issued with a bounded lifetime chosen here.
  const [expiryDays, setExpiryDays] = useState(90);
  const [issued, setIssued] = useState<{ token: string; prefix: string; expiresAt?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try { setTokens(await api.scimTokens()); }
    catch (e: any) { setErr(e.displayMessage || 'load failed'); }
  }
  useEffect(() => { refresh(); }, []);

  async function issue() {
    setBusy(true); setErr(null); setCopied(false);
    try {
      const r = await api.scimIssue(name, expiryDays);
      setIssued({ token: r.token, prefix: r.prefix, expiresAt: r.expiresAt });
      await refresh();
    } catch (e: any) {
      setErr(e.displayMessage || 'issue failed');
    } finally { setBusy(false); }
  }

  async function copyToken() {
    if (!issued) return;
    try { await navigator.clipboard.writeText(issued.token); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { /* clipboard blocked (insecure context) — admin can still select manually */ }
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
          <label>{t('scim.expiry')}
            <select value={expiryDays} onChange={(e) => setExpiryDays(+e.target.value)}>
              <option value={30}>{t('scim.expiry30')}</option>
              <option value={90}>{t('scim.expiry90')}</option>
              <option value={180}>{t('scim.expiry180')}</option>
              <option value={365}>{t('scim.expiry365')}</option>
            </select>
          </label>
          <button className="btn primary" disabled={busy} onClick={issue}>{t('scim.issue')}</button>
        </div>
        {issued && (
          <div className="banner" style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong>{t('scim.savedTitle')}.</strong>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn ghost" onClick={copyToken}>
                {copied ? <><Check size={14} /> {t('scim.copied')}</> : <><Copy size={14} /> {t('scim.copy')}</>}
              </button>
            </div>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{issued.token}</pre>
            {issued.expiresAt && <small className="muted">{t('scim.expiresOn', { date: new Date(issued.expiresAt).toLocaleDateString() })}</small>}
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
            <thead><tr><th>{t('scim.name')}</th><th>{t('scim.prefix')}</th><th>{t('scim.created')}</th><th>{t('scim.lastUsed')}</th><th>{t('scim.expires')}</th><th></th></tr></thead>
            <tbody>
              {tokens.map((tok) => {
                const expired = tok.expiresAt ? new Date(tok.expiresAt).getTime() <= Date.now() : true;
                return (
                <tr key={tok.id}>
                  <td>{tok.name}</td>
                  <td><code>{tok.prefix}…</code></td>
                  <td>{new Date(tok.createdAt).toLocaleString()}</td>
                  <td>{tok.lastUsedAt ? new Date(tok.lastUsedAt).toLocaleString() : '—'}</td>
                  <td>
                    {tok.expiresAt
                      ? <span className={`tag ${expired ? 'bad' : 'ok'}`}>{new Date(tok.expiresAt).toLocaleDateString()}</span>
                      : <span className="tag bad">{t('scim.noExpiry')}</span>}
                  </td>
                  <td><button className="btn ghost" onClick={() => revoke(tok.id)}>{t('scim.revoke')}</button></td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
