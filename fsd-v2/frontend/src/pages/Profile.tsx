import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../hooks/useT';
import { b64uToBytes, serializeAttestation } from './Login';
import { confirmDialog } from '../stores/confirm';

type Passkey = { id: string; nickname: string; aaguid: string; createdAt: string; lastUsedAt?: string };

// Profile screen: account header, MFA enrolment block, and the
// passkey list. Mirrors the v1 Profile.vue view but laid out for the
// v2 React shell.
export function Profile() {
  const { t } = useT();
  const user = useAuth((s) => s.user);
  const [mfa, setMfa] = useState<{ enabled: boolean; enrolledAt?: string | null }>({ enabled: false });
  const [enrol, setEnrol] = useState<{ qrDataUrl: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [nickname, setNickname] = useState(t('profile.defaultPasskeyName'));

  async function refresh() {
    const [s, list] = await Promise.all([api.mfaStatus(), api.passkeyList().catch(() => [])]);
    setMfa(s);
    setPasskeys(list);
  }
  useEffect(() => { refresh(); }, []);

  async function startEnrol() {
    setBusy(true); setMsg(null);
    try { setEnrol(await api.mfaEnroll()); }
    catch (e: any) { setMsg(e.displayMessage || t('profile.enrollFailed')); }
    finally { setBusy(false); }
  }
  async function verify() {
    setBusy(true); setMsg(null);
    try { await api.mfaVerify(code); setCode(''); setEnrol(null); setMsg(t('profile.mfaEnabledMsg')); await refresh(); }
    catch (e: any) { setMsg(e.displayMessage || t('profile.invalidCode')); }
    finally { setBusy(false); }
  }
  async function disable() {
    if (!code) { setMsg(t('profile.enterCodeToDisarm')); return; }
    setBusy(true);
    try { await api.mfaDisable(code); setCode(''); setMsg(t('profile.mfaDisabledMsg')); await refresh(); }
    catch (e: any) { setMsg(e.displayMessage || t('profile.disarmFailed')); }
    finally { setBusy(false); }
  }

  async function enrolPasskey() {
    setBusy(true); setMsg(null);
    try {
      const opts: any = await api.passkeyRegisterStart();
      const cred = await navigator.credentials.create({
        publicKey: {
          ...opts,
          challenge: b64uToBytes(opts.challenge),
          user: { ...opts.user, id: typeof opts.user.id === 'string' ? b64uToBytes(opts.user.id) : opts.user.id },
          excludeCredentials: (opts.excludeCredentials || []).map((c: any) => ({
            ...c, id: b64uToBytes(c.id),
          })),
        },
      } as any);
      const response = serializeAttestation(cred as PublicKeyCredential);
      await api.passkeyRegisterFinish(response, nickname);
      setMsg(t('profile.passkeyEnrolledMsg'));
      await refresh();
    } catch (e: any) {
      setMsg(e.displayMessage || e.message || t('profile.passkeyEnrolFailed'));
    } finally { setBusy(false); }
  }
  async function removePasskey(id: string) {
    if (!(await confirmDialog({ title: t('profile.confirmRemovePasskey'), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.passkeyDelete(id);
    await refresh();
  }

  return (
    <div className="profile-page" style={{ display: 'grid', gap: 24, maxWidth: 720 }}>
      <section className="card">
        <h2>{t('settings.account')}</h2>
        <div className="grid">
          <div><label>{t('settings.username')}</label><div>{user?.username}</div></div>
          <div><label>{t('settings.role')}</label><div>{user?.role}</div></div>
          <div><label>{t('settings.tenant')}</label><div>{user?.tenantSlug || user?.tenantId}</div></div>
        </div>
      </section>

      <section className="card">
        <h2>{t('profile.totpTitle')}</h2>
        <p className="muted">
          {t('profile.statusLabel')} <strong>{mfa.enabled ? t('profile.statusEnabled') : t('profile.statusDisabled')}</strong>
          {mfa.enrolledAt && <> &middot; {t('profile.since', { time: new Date(mfa.enrolledAt).toLocaleString() })}</>}
        </p>

        {!mfa.enabled && !enrol && (
          <button className="btn primary" disabled={busy} onClick={startEnrol}>{t('profile.startEnrolment')}</button>
        )}
        {enrol && (
          <div className="enrol-block">
            <p>{t('profile.scanInstruction')}</p>
            <img src={enrol.qrDataUrl} alt={t('profile.qrAlt')} style={{ width: 200, height: 200 }} />
            <p className="muted"><code>{enrol.otpauthUrl}</code></p>
            <label>{t('profile.code')} <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label>
            <button className="btn primary" disabled={busy || code.length < 6} onClick={verify}>{t('profile.verifyEnable')}</button>
          </div>
        )}
        {mfa.enabled && (
          <div className="disable-block">
            <label>{t('profile.currentCode')} <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" /></label>
            <button className="btn" disabled={busy} onClick={disable}>{t('profile.disableMfa')}</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t('profile.passkeys')}</h2>
        <p className="muted">{t('profile.passkeysHelp')}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end' }}>
          <label style={{ flex: 1 }}>{t('profile.nickname')}
            <input value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </label>
          <button className="btn primary" disabled={busy} onClick={enrolPasskey}>{t('profile.addPasskey')}</button>
        </div>
        {passkeys.length === 0 ? (
          <p className="muted">{t('profile.noPasskeys')}</p>
        ) : (
          <table>
            <thead><tr><th>{t('profile.nickname')}</th><th>{t('profile.created')}</th><th>{t('profile.lastUsed')}</th><th></th></tr></thead>
            <tbody>
              {passkeys.map((p) => (
                <tr key={p.id}>
                  <td>{p.nickname}</td>
                  <td>{new Date(p.createdAt).toLocaleString()}</td>
                  <td>{p.lastUsedAt ? new Date(p.lastUsedAt).toLocaleString() : '—'}</td>
                  <td><button className="btn ghost" onClick={() => removePasskey(p.id)}>{t('profile.remove')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {msg && <div className="banner">{msg}</div>}
    </div>
  );
}
