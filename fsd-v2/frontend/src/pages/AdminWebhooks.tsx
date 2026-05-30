import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// AdminWebhooks — registers outbound webhook subscriptions and shows the
// recent delivery log. Mirrors v1's AdminWebhooks.vue. The secret is
// shown once on create and never again.

type Hook = {
  id: string;
  targetURL: string;
  events: string[];
  isActive: boolean;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
};
type Delivery = {
  id: string;
  subscriptionId: string;
  event: string;
  status: string;
  attemptCount: number;
  lastStatus: number | null;
  lastError: string;
  createdAt: string;
  deliveredAt: string | null;
};

const KNOWN_EVENTS = [
  'booking.created', 'booking.updated', 'booking.cancelled',
  'booking.approved', 'booking.rejected', 'weather.signal',
];

export function AdminWebhooks() {
  const { t } = useT();
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [draft, setDraft] = useState<{ targetURL: string; events: string[] }>({ targetURL: '', events: KNOWN_EVENTS });
  // newSecret holds the one-time secret returned by POST so the operator
  // can copy it. Cleared on the next page action.
  const [newSecret, setNewSecret] = useState<{ id: string; secret: string } | null>(null);

  useEffect(() => { reload(); }, []);
  function reload() {
    api.listWebhooks().then(setHooks);
    api.listWebhookDeliveries().then(setDeliveries);
  }

  async function create() {
    if (!draft.targetURL) return;
    try {
      const r = await api.createWebhook(draft);
      setNewSecret({ id: r.id, secret: r.secret });
      setDraft({ targetURL: '', events: KNOWN_EVENTS });
      reload();
    } catch (e: any) {
      await alertDialog({ title: t('common.error'), message: e.displayMessage, tone: 'danger' });
    }
  }
  async function toggle(h: Hook) {
    await api.updateWebhook(h.id, { isActive: !h.isActive });
    reload();
  }
  async function remove(h: Hook) {
    if (!(await confirmDialog({ title: t('webhooks.confirmDeleteUrl', { url: h.targetURL }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteWebhook(h.id);
    reload();
  }

  function toggleEvent(ev: string) {
    setDraft((d) => ({
      ...d,
      events: d.events.includes(ev) ? d.events.filter((e) => e !== ev) : [...d.events, ev],
    }));
  }

  return (
    <div>
      <header className="page-head"><h1>{t('webhooks.title')}</h1></header>

      <section className="card">
        <h2>{t('webhooks.new')}</h2>
        <p className="muted">
          {t('webhooks.ssrfHelp')}
        </p>
        <div className="row">
          <input
            value={draft.targetURL}
            onChange={(e) => setDraft({ ...draft, targetURL: e.target.value })}
            placeholder="https://example.com/hooks/fsd"
            style={{ flex: 1 }}
          />
          <button className="btn primary" onClick={create}>{t('webhooks.create')}</button>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
          {KNOWN_EVENTS.map((ev) => (
            <label key={ev} className="chip">
              <input
                type="checkbox"
                checked={draft.events.includes(ev)}
                onChange={() => toggleEvent(ev)}
              />
              {ev}
            </label>
          ))}
        </div>
        {newSecret && (
          <div className="banner warning">
            <strong>{t('webhooks.secretTitle')}:</strong>
            <pre><code>{newSecret.secret}</code></pre>
            <button className="btn ghost" onClick={() => setNewSecret(null)}>{t('common.close')}</button>
          </div>
        )}
      </section>

      <section className="card">
        <h2>{t('webhooks.registered', { n: hooks.length })}</h2>
        <table className="data">
          <thead><tr><th>{t('webhooks.url')}</th><th>{t('webhooks.events')}</th><th>{t('webhooks.status')}</th><th>{t('webhooks.updated')}</th><th></th></tr></thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id}>
                <td><code>{h.targetURL}</code></td>
                <td>{h.events.join(', ')}</td>
                <td><span className={`tag ${h.isActive ? 'ok' : 'bad'}`}>{h.isActive ? t('common.active') : t('webhooks.paused')}</span></td>
                <td>{new Date(h.updatedAt).toLocaleString()}</td>
                <td>
                  <button className="btn ghost" onClick={() => toggle(h)}>
                    {h.isActive ? t('webhooks.pause') : t('webhooks.resume')}
                  </button>{' '}
                  <button className="btn danger" onClick={() => remove(h)}>{t('common.delete')}</button>
                </td>
              </tr>
            ))}
            {hooks.length === 0 && (
              <tr><td colSpan={5} className="muted">{t('webhooks.empty')}</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>{t('webhooks.deliveries')}</h2>
        <table className="data">
          <thead>
            <tr><th>{t('webhooks.event')}</th><th>{t('webhooks.status')}</th><th>{t('webhooks.attempts')}</th><th>{t('webhooks.http')}</th><th>{t('webhooks.errorCol')}</th><th>{t('webhooks.when')}</th></tr>
          </thead>
          <tbody>
            {deliveries.slice(0, 100).map((d) => (
              <tr key={d.id}>
                <td><code>{d.event}</code></td>
                <td><span className={`tag ${d.status === 'sent' ? 'ok' : d.status === 'failed' ? 'bad' : ''}`}>{d.status}</span></td>
                <td>{d.attemptCount}</td>
                <td>{d.lastStatus ?? '—'}</td>
                <td className="muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.lastError || '—'}</td>
                <td>{new Date(d.createdAt).toLocaleString()}</td>
              </tr>
            ))}
            {deliveries.length === 0 && (
              <tr><td colSpan={6} className="muted">{t('webhooks.noDeliveries')}</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}
