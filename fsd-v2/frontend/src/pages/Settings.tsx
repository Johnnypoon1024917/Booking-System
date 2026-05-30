import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../hooks/useT';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { confirmDialog } from '../stores/confirm';

// Self-service settings panel — direct port of v1's Settings.vue. Surfaces
// the user-facing capabilities so people can use them without admin help:
//   • Account            (read-only profile from the auth store)
//   • Multi-factor auth  (enrol, activate, disarm)
//   • Calendar feed      (mint a subscribable iCal URL)
//   • Browser push       (subscribe / unsubscribe via service worker)
//   • Data & privacy     (DSAR export, right-to-erasure)
// Errors render inline via the status line so screen readers see them.
export function Settings() {
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const nav = useNavigate();
  const { t } = useT();
  const push = usePushSubscription();

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  // MFA state
  const [mfaEnabled, setMfaEnabled] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [otpauthUrl, setOtpauthUrl] = useState('');
  const [secretPretty, setSecretPretty] = useState('');
  const [code, setCode] = useState('');
  const [mfaError, setMfaError] = useState('');

  // Calendar feed state
  const [calUrl, setCalUrl] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const s = await api.mfaStatus();
      setMfaEnabled(!!s?.enabled);
    } catch { /* endpoint may be disabled */ }
  }

  // ---- MFA -------------------------------------------------------
  async function enrolMFA() {
    setBusy(true); setMfaError('');
    try {
      const r = await api.mfaEnroll();
      setQrDataUrl(r.qrDataUrl || '');
      setOtpauthUrl(r.otpauthUrl || '');
      // Use the secret the API returns directly; only fall back to scraping the
      // otpauth URL if an older backend omits it. Authenticator apps group the
      // secret in fours for easier manual entry.
      const secret = r.secret
        || new URLSearchParams((r.otpauthUrl || '').split('?')[1] || '').get('secret')
        || '';
      setSecretPretty(secret.match(/.{1,4}/g)?.join(' ') || secret);
      setEnrolling(true);
    } catch (e: any) { setMfaError(e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  async function activateMFA() {
    setBusy(true); setMfaError('');
    try {
      await api.mfaVerify(code);
      setMfaEnabled(true);
      cancelEnrol();
      setStatus('MFA activated.');
    } catch { setMfaError('Invalid code — try again.'); }
    finally { setBusy(false); }
  }

  function cancelEnrol() {
    setEnrolling(false); setQrDataUrl(''); setOtpauthUrl('');
    setSecretPretty(''); setCode(''); setMfaError('');
  }

  async function disarmMFA() {
    setBusy(true);
    try {
      await api.mfaDisable(code);
      setMfaEnabled(false); setCode('');
      setStatus('MFA disabled.');
    } catch (e: any) { setStatus(e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secretPretty.replace(/\s/g, ''));
      setStatus('Secret copied — paste it into your authenticator app if you cannot scan.');
    } catch { setStatus('Copy failed; select the text manually.'); }
  }

  // ---- Calendar feed --------------------------------------------
  async function mintCalendar() {
    setBusy(true);
    try {
      const { token } = await api.icsToken();
      const slug = user?.tenantSlug || user?.tenantId || '';
      setCalUrl(api.icsFeedUrl(slug, token));
    } catch (e: any) { setStatus(e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  function copyCal(e: React.FocusEvent<HTMLInputElement>) {
    e.target.select();
    navigator.clipboard?.writeText(calUrl).catch(() => undefined);
  }

  // ---- Push ------------------------------------------------------
  async function subscribePush() {
    setBusy(true);
    const ok = await push.subscribe();
    setStatus(ok ? 'Push notifications enabled.' : 'Could not enable push notifications.');
    setBusy(false);
  }
  async function unsubscribePush() {
    setBusy(true);
    await push.unsubscribe();
    setStatus('Push notifications disabled.');
    setBusy(false);
  }

  // ---- DSAR ------------------------------------------------------
  async function exportData() {
    setBusy(true);
    try {
      const resp = await api.dsarExportMe();
      // The client requests responseType:'blob', but guard anyway: if a proxy
      // or error path hands back parsed JSON, createObjectURL would throw — wrap
      // non-Blob payloads so the download never crashes.
      const data: Blob = resp.data instanceof Blob
        ? resp.data
        : new Blob([JSON.stringify(resp.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(data);
      const a = Object.assign(document.createElement('a'), { href: url, download: 'my-data.json' });
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) { setStatus(e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  async function eraseAccount() {
    // Real self-service erasure (V1 parity): the backend anonymises the account
    // + the caller's bookings and deactivates the login, so the dialog states
    // the true, irreversible effect. On success we drop the session and bounce
    // to /login — the account can no longer authenticate.
    if (!(await confirmDialog({
      title: 'Erase my account',
      message: 'This permanently erases your personal data, cancels your upcoming bookings, and disables your login. This cannot be undone. Continue?',
      tone: 'danger', confirmText: 'Erase my account', cancelText: 'Cancel',
    }))) return;
    setBusy(true);
    try {
      await api.eraseMyAccount();
      logout();
      nav('/login');
    } catch (e: any) {
      setStatus(e.displayMessage || e.message || 'Could not erase account — please try again.');
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{t('settings.title')}</h1>
          <p className="muted">{t('settings.subtitle')}</p>
        </div>
      </div>

      <section className="fsd-card" style={{ marginBottom: 18 }}>
        <h2>{t('settings.account')}</h2>
        <dl className="kv">
          <dt>{t('settings.username')}</dt><dd>{user?.username || '—'}</dd>
          <dt>{t('settings.role')}</dt><dd>{user?.role || '—'}</dd>
          <dt>{t('settings.tenant')}</dt><dd><code>{user?.tenantSlug || user?.tenantId || '—'}</code></dd>
        </dl>
      </section>

      <section className="fsd-card" style={{ marginBottom: 18 }}>
        <h2>{t('settings.mfa')}</h2>
        <p className="muted text-sm">{t('settings.mfaHelp')}</p>
        {mfaEnabled
          ? <p className="tag success">{t('settings.mfaEnabled')}</p>
          : <p className="tag warning">{t('settings.mfaDisabled')}</p>}

        {!mfaEnabled && !enrolling && (
          <div className="row gap-sm" style={{ marginTop: 12 }}>
            <button type="button" className="btn-fsd" onClick={enrolMFA} disabled={busy}>{t('settings.mfaEnrol')}</button>
          </div>
        )}

        {enrolling && (
          <div style={{ marginTop: 12 }}>
            <ol className="enrol-steps">
              <li>{t('settings.mfaStepInstall')}</li>
              <li>
                {t('settings.mfaStepScan')}
                <div className="qr-block">{qrDataUrl && <img src={qrDataUrl} alt={t('settings.mfaScan')} width={220} height={220}/>}</div>
              </li>
              <li>
                {t('settings.mfaStepManual')}
                <div className="manual-row">
                  <code className="manual-secret">{secretPretty}</code>
                  <button type="button" className="btn-fsd ghost" onClick={copySecret}>{t('common.copy')}</button>
                </div>
                <small className="muted">{t('settings.mfaManualHint')}</small>
              </li>
              <li>
                <label>{t('settings.mfaStepCode')}
                  <input value={code} onChange={(e) => { setCode(e.target.value); if (mfaError) setMfaError(''); }} inputMode="numeric"
                         autoComplete="one-time-code" maxLength={6} pattern="[0-9]*" autoFocus/>
                </label>
              </li>
            </ol>
            {mfaError && <p className="error">{mfaError}</p>}
            <div className="row gap-sm" style={{ marginTop: 12 }}>
              <button type="button" className="btn-fsd" onClick={activateMFA} disabled={busy || !code}>{t('settings.mfaActivate')}</button>
              <button type="button" className="btn-fsd ghost" onClick={cancelEnrol}>{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {mfaEnabled && (
          <div style={{ marginTop: 12 }}>
            <label>{t('settings.mfaDisarmCode')}
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6}/>
            </label>
            <button type="button" className="btn-fsd danger" onClick={disarmMFA} disabled={busy || !code} style={{ marginTop: 8 }}>{t('settings.mfaDisarm')}</button>
          </div>
        )}
      </section>

      <section className="fsd-card" style={{ marginBottom: 18 }}>
        <h2>{t('settings.calendar')}</h2>
        <p className="muted text-sm">{t('settings.calendarHelp')}</p>
        {calUrl && (
          <label style={{ marginTop: 8 }}>{t('settings.calendarUrl')}
            <input value={calUrl} readOnly onFocus={copyCal} aria-label={t('settings.calendarUrl')}/>
          </label>
        )}
        <button type="button" className="btn-fsd" onClick={mintCalendar} disabled={busy} style={{ marginTop: 12 }}>
          {calUrl ? t('settings.calendarRotate') : t('settings.calendarGenerate')}
        </button>
      </section>

      <section className="fsd-card" style={{ marginBottom: 18 }}>
        <h2>{t('settings.push')}</h2>
        <p className="muted text-sm">{t('settings.pushHelp')}</p>
        {!push.supported
          ? <p className="tag warning">{t('settings.pushUnsupported')}</p>
          : push.subscribed
            ? <p className="tag success">{t('settings.pushOn')}</p>
            : <p className="tag">{t('settings.pushOff')}</p>}
        {push.supported && (
          <div className="row gap-sm" style={{ marginTop: 12 }}>
            {!push.subscribed
              ? <button type="button" className="btn-fsd" onClick={subscribePush} disabled={busy}>{t('settings.pushSubscribe')}</button>
              : <button type="button" className="btn-fsd ghost" onClick={unsubscribePush} disabled={busy}>{t('settings.pushUnsubscribe')}</button>}
          </div>
        )}
      </section>

      <section className="fsd-card" style={{ marginBottom: 18 }}>
        <h2>{t('settings.privacy')}</h2>
        <p className="muted text-sm">{t('settings.privacyHelp')}</p>
        <div className="row gap-sm" style={{ marginTop: 12 }}>
          <button type="button" className="btn-fsd ghost" onClick={exportData} disabled={busy}>{t('settings.exportData')}</button>
          <button type="button" className="btn-fsd danger" onClick={eraseAccount} disabled={busy}>{t('settings.eraseAccount')}</button>
        </div>
      </section>

      {status && <p className="status" role="status">{status}</p>}
    </div>
  );
}
