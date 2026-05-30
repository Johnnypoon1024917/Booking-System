import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useT } from '../hooks/useT';

type SsoProvider = { slug: string; name: string; kind: 'saml' | 'oauth2' | 'ldap' };

// Login flow:
//   1. Password step → server may return { requiresMfa, mfaToken }
//   2. If MFA required, render code input + POST to /mfa/login-verify
//   3. Else render the SSO picker beneath; clicking a SAML/OAuth2 row
//      hits the appropriate init endpoint (browser nav), LDAP rows
//      prompt for username/password in-page.
export function Login() {
  const { t } = useT();
  const [tenantSlug, setSlug] = useState('default');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  // Forced first-login password reset state.
  const [changeToken, setChangeToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [providers, setProviders] = useState<SsoProvider[]>([]);
  const login = useAuth((s) => s.login);
  const nav = useNavigate();

  // Refresh SSO catalog whenever the tenant slug changes — slug is what
  // partitions providers server-side.
  useEffect(() => {
    api.ssoProviders(tenantSlug).then(setProviders).catch(() => setProviders([]));
  }, [tenantSlug]);

  // If the API client bounced us here on a 401, explain why rather than
  // showing a bare login form (the user's session expired mid-action).
  useEffect(() => {
    if (sessionStorage.getItem('fsd_session_expired')) {
      sessionStorage.removeItem('fsd_session_expired');
      setNotice(t('login.sessionExpired'));
    }
  }, [t]);

  // After any successful auth, return the user to where they were when the
  // session expired (if known), else the dashboard.
  function afterLogin() {
    const to = sessionStorage.getItem('fsd_return_to');
    sessionStorage.removeItem('fsd_return_to');
    nav(to && to !== '/login' ? to : '/');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.login(tenantSlug, username, password);
      if (r.mustChangePassword) {
        setChangeToken(r.changeToken);
      } else if (r.requiresMfa) {
        setMfaToken(r.mfaToken);
      } else {
        login(r.accessToken, r.user);
        afterLogin();
      }
    } catch (e: any) {
      setErr(e.displayMessage || t('login.loginFailed'));
    } finally { setBusy(false); }
  }

  async function submitMfa(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r = await api.mfaLoginVerify(mfaToken!, mfaCode);
      login(r.accessToken, r.user);
      afterLogin();
    } catch (e: any) {
      setErr(e.displayMessage || t('login.invalidCode'));
    } finally { setBusy(false); }
  }

  async function submitChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword !== confirmPassword) { setErr(t('login.passwordsMismatch')); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api.changePassword(changeToken!, newPassword);
      login(r.accessToken, r.user);
      afterLogin();
    } catch (e: any) {
      setErr(e.displayMessage || t('login.changeFailed'));
    } finally { setBusy(false); }
  }

  async function passkeyLogin() {
    setBusy(true); setErr(null);
    try {
      const opts: any = await api.passkeyLoginStart(tenantSlug, username);
      // Browser turns the base64url challenge into a Uint8Array via the
      // WebAuthn API helper; @simplewebauthn/browser would also work
      // but we don't want another dep just for the SPA.
      const cred = await navigator.credentials.get({
        publicKey: {
          ...opts,
          challenge: b64uToBytes(opts.challenge),
          allowCredentials: (opts.allowCredentials || []).map((c: any) => ({
            ...c, id: b64uToBytes(c.id),
          })),
        },
      } as any);
      const response = serializeAssertion(cred as PublicKeyCredential);
      const r = await api.passkeyLoginFinish(tenantSlug, username, response);
      login(r.accessToken, r.user);
      afterLogin();
    } catch (e: any) {
      setErr(e.displayMessage || e.message || t('login.passkeyFailed'));
    } finally { setBusy(false); }
  }

  function startSso(p: SsoProvider) {
    const base = `/api/v1/sso/${p.kind}/init`;
    const params = new URLSearchParams({ tenant: tenantSlug, provider: p.slug, redirect: '/' });
    window.location.href = `${base}?${params.toString()}`;
  }

  // ---- render ----
  if (changeToken) {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={submitChangePassword}>
          <h1>{t('login.setNewPassword')}</h1>
          <p className="muted">{t('login.mustChangeHelp')}</p>
          <label>{t('login.newPassword')}<input type="password" value={newPassword} autoFocus
            onChange={(e) => setNewPassword(e.target.value)} /></label>
          <label>{t('login.confirmPassword')}<input type="password" value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)} /></label>
          {err && <div className="err">{err}</div>}
          <button className="btn primary" disabled={busy || newPassword.length < 8}>
            {busy ? t('login.signingIn') : t('login.setPasswordContinue')}
          </button>
        </form>
      </div>
    );
  }
  if (mfaToken) {
    return (
      <div className="login-page">
        <form className="login-card" onSubmit={submitMfa}>
          <h1>{t('login.twoFactor')}</h1>
          <p className="muted">{t('login.enterCode')}</p>
          <label>{t('login.code')}<input value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} autoFocus inputMode="numeric" /></label>
          {err && <div className="err">{err}</div>}
          <button className="btn primary" disabled={busy || mfaCode.length < 6}>{t('login.verify')}</button>
          <button type="button" className="btn ghost" onClick={() => { setMfaToken(null); setMfaCode(''); }}>
            {t('login.back')}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <h1>FSD MRBS</h1>
        {notice && <div className="notice" role="status">{notice}</div>}
        <p className="muted">{t('login.signInTenant')}</p>
        <label>{t('login.tenant')}<input value={tenantSlug} onChange={(e) => setSlug(e.target.value)} /></label>
        <label>{t('login.username')}<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
        <label>{t('login.password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? t('login.signingIn') : t('login.signIn')}</button>
        <button type="button" className="btn ghost" onClick={passkeyLogin} disabled={busy || !username}>
          {t('login.signInPasskey')}
        </button>

        {providers.length > 0 && (
          <div className="sso-picker">
            <div className="sso-sep"><span>{t('login.orSignInWith')}</span></div>
            {providers.map((p) => (
              <button
                key={p.slug}
                type="button"
                className="btn ghost"
                onClick={() => p.kind === 'ldap' ? submit({ preventDefault() {} } as any) : startSso(p)}
              >
                {p.name} <span className="muted">({p.kind})</span>
              </button>
            ))}
          </div>
        )}
        <p className="muted hint">Dev login: <code>default / admin / admin</code></p>
      </form>
    </div>
  );
}

// ---- WebAuthn browser helpers ----
function b64uToBytes(s: string): Uint8Array {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64u(b: ArrayBuffer): string {
  let s = '';
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function serializeAssertion(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      authenticatorData: bytesToB64u(r.authenticatorData),
      signature: bytesToB64u(r.signature),
      userHandle: r.userHandle ? bytesToB64u(r.userHandle) : null,
    },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
  };
}
export function serializeAttestation(cred: PublicKeyCredential) {
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: bytesToB64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bytesToB64u(r.clientDataJSON),
      attestationObject: bytesToB64u(r.attestationObject),
      transports: (r as any).getTransports?.() || [],
    },
    clientExtensionResults: cred.getClientExtensionResults?.() || {},
  };
}
export { b64uToBytes, bytesToB64u };
