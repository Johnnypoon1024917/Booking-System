import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// AdminIntegrations — per-provider credential editor and the resource ↔
// M365 mailbox map. Mirrors v1's AdminIntegrations.vue. Secrets are
// write-only: the input is blank when "configured" so a save without
// touching it keeps the existing ciphertext.

type Cred = {
  provider: string;
  azureTenantID?: string;
  clientID?: string;
  hasSecret: boolean;
  isActive: boolean;
  lastTestOk?: boolean | null;
  lastTestError?: string;
  lastTestedAt?: string | null;
};
type Mailbox = {
  id: string;
  resourceId: string;
  mailboxUPN: string;
  displayName: string;
  isActive: boolean;
};

const PROVIDERS = [
  { id: 'microsoft', label: 'Microsoft 365 (Outlook + Teams)', labelKey: 'integrations.providerMicrosoft', needsTenant: true, secretLabel: 'Client secret', secretLabelKey: 'integrations.secretClientSecret' },
  { id: 'google', label: 'Google Calendar', labelKey: 'integrations.providerGoogle', needsTenant: false, secretLabel: 'Service account JSON', secretLabelKey: 'integrations.secretServiceAccountJson' },
  { id: 'teams-bot', label: 'Teams Bot (proactive)', labelKey: 'integrations.providerTeamsBot', needsTenant: false, secretLabel: 'Bot password', secretLabelKey: 'integrations.secretBotPassword' },
  { id: 'zoom', label: 'Zoom', labelKey: 'integrations.providerZoom', needsTenant: false, secretLabel: 'Client secret', secretLabelKey: 'integrations.secretClientSecret' },
];

export function AdminIntegrations() {
  const { t } = useT();
  const [creds, setCreds] = useState<Cred[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [draft, setDraft] = useState<Record<string, { azureTenantID?: string; clientID?: string; clientSecret?: string }>>({});
  const [newMailbox, setNewMailbox] = useState<{ resourceId: string; mailboxUPN: string }>({ resourceId: '', mailboxUPN: '' });
  const [testStatus, setTestStatus] = useState<Record<string, string>>({});

  useEffect(() => { reload(); }, []);
  function reload() {
    api.listIntegrations().then(setCreds);
    api.listMailboxes().then(setMailboxes);
    api.adminResources().then(setResources);
  }

  function findCred(provider: string) {
    return creds.find((c) => c.provider === provider);
  }

  async function save(provider: string) {
    const d = draft[provider] || {};
    try {
      await api.saveIntegration(provider, d);
      setDraft({ ...draft, [provider]: {} });
      reload();
    } catch (e: any) {
      await alertDialog({ title: t('common.error'), message: e.displayMessage, tone: 'danger' });
    }
  }
  async function remove(provider: string) {
    if (!(await confirmDialog({ title: t('integrations.confirmRemove', { provider }), tone: 'danger', confirmText: t('common.confirm'), cancelText: t('common.cancel') }))) return;
    await api.deleteIntegration(provider);
    reload();
  }
  async function test(provider: string) {
    setTestStatus({ ...testStatus, [provider]: t('integrations.testing') });
    try {
      const r = await api.testIntegration(provider);
      setTestStatus({ ...testStatus, [provider]: r.ok ? t('integrations.testOK') : t('integrations.testFailedReason', { reason: r.error || 'unknown' }) });
      reload();
    } catch (e: any) {
      setTestStatus({ ...testStatus, [provider]: t('integrations.testFailedReason', { reason: e.displayMessage || e.message }) });
    }
  }

  async function addMailbox() {
    if (!newMailbox.resourceId || !newMailbox.mailboxUPN) return;
    try {
      await api.saveMailbox(newMailbox);
      setNewMailbox({ resourceId: '', mailboxUPN: '' });
      reload();
    } catch (e: any) {
      await alertDialog({ title: t('common.error'), message: e.displayMessage, tone: 'danger' });
    }
  }
  async function removeMailbox(resourceId: string) {
    if (!(await confirmDialog({ title: t('integrations.confirmUnmap'), tone: 'danger', confirmText: t('common.confirm'), cancelText: t('common.cancel') }))) return;
    await api.deleteMailbox(resourceId);
    reload();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('integrations.title')}</h1>
        <button className="btn ghost" onClick={async () => { await api.graphSync(); await alertDialog({ title: t('integrations.reconcileTriggered') }); }}>
          {t('integrations.forceReconcile')}
        </button>
      </header>

      <section className="card">
        <h2>{t('integrations.providers')}</h2>
        <table className="data">
          <thead>
            <tr>
              <th>{t('integrations.provider')}</th><th>{t('integrations.azureTenant')}</th><th>{t('integrations.clientIdCol')}</th>
              <th>{t('integrations.secret')}</th><th>{t('integrations.lastTest')}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {PROVIDERS.map((p) => {
              const c = findCred(p.id);
              const d = draft[p.id] || {};
              return (
                <tr key={p.id}>
                  <td>
                    <strong>{t(p.labelKey, { defaultValue: p.label })}</strong>
                    {c ? <div className={`tag ${c.isActive ? 'ok' : 'bad'}`}>{c.isActive ? t('common.active') : t('integrations.disabled')}</div> : <div className="tag">{t('integrations.notConfigured')}</div>}
                  </td>
                  <td>
                    {p.needsTenant ? (
                      <input
                        value={d.azureTenantID ?? c?.azureTenantID ?? ''}
                        onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, azureTenantID: e.target.value } })}
                        placeholder="contoso.onmicrosoft.com"
                      />
                    ) : '—'}
                  </td>
                  <td>
                    <input
                      value={d.clientID ?? c?.clientID ?? ''}
                      onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, clientID: e.target.value } })}
                      placeholder="app / client id"
                    />
                  </td>
                  <td>
                    <input
                      type="password"
                      value={d.clientSecret ?? ''}
                      onChange={(e) => setDraft({ ...draft, [p.id]: { ...d, clientSecret: e.target.value } })}
                      placeholder={c?.hasSecret ? t('integrations.secretKeepBlank') : t(p.secretLabelKey, { defaultValue: p.secretLabel })}
                    />
                  </td>
                  <td>
                    {testStatus[p.id]
                      ? <span>{testStatus[p.id]}</span>
                      : c?.lastTestOk === true
                        ? <span className="tag ok">{t('integrations.ok')}</span>
                        : c?.lastTestOk === false
                          ? <span className="tag bad" title={c.lastTestError}>{t('integrations.failed')}</span>
                          : <span className="tag">—</span>}
                  </td>
                  <td>
                    <button className="btn primary" onClick={() => save(p.id)}>{t('common.save')}</button>{' '}
                    {p.id === 'microsoft' && <button className="btn ghost" onClick={() => test(p.id)}>{t('integrations.test')}</button>}{' '}
                    {c && <button className="btn danger" onClick={() => remove(p.id)}>{t('integrations.remove')}</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>{t('integrations.mailboxes')}</h2>
        <p className="muted">
          {t('integrations.mailboxMapHelp')}
        </p>
        <div className="row">
          <select
            aria-label={t('integrations.pickRoom')}
            value={newMailbox.resourceId}
            onChange={(e) => setNewMailbox({ ...newMailbox, resourceId: e.target.value })}
          >
            <option value="">{t('integrations.pickRoom')}</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
          <input
            value={newMailbox.mailboxUPN}
            onChange={(e) => setNewMailbox({ ...newMailbox, mailboxUPN: e.target.value })}
            placeholder="room@contoso.com"
          />
          <button className="btn primary" onClick={addMailbox}>{t('integrations.map')}</button>
        </div>
        <table className="data">
          <thead><tr><th>{t('integrations.room')}</th><th>{t('integrations.mailboxUpn')}</th><th>{t('integrations.status')}</th><th></th></tr></thead>
          <tbody>
            {mailboxes.map((m) => {
              const r = resources.find((x) => x.id === m.resourceId);
              return (
                <tr key={m.id}>
                  <td>{r?.name || m.resourceId}</td>
                  <td><code>{m.mailboxUPN}</code></td>
                  <td><span className={`tag ${m.isActive ? 'ok' : 'bad'}`}>{m.isActive ? t('common.active') : t('integrations.disabled')}</span></td>
                  <td><button className="btn danger" onClick={() => removeMailbox(m.resourceId)}>{t('integrations.unmap')}</button></td>
                </tr>
              );
            })}
            {mailboxes.length === 0 && (
              <tr><td colSpan={4} className="muted">{t('integrations.noMappings')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
