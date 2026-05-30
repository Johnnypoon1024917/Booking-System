import { useEffect, useState } from 'react';
import { Megaphone, Pencil, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// R13 broadcast composer. Mirrors v1's AdminBroadcasts.vue: a list of
// published broadcasts on the left, a create/edit modal on the right.
// The banner colour falls back from severity by default; admins can
// override with a custom hex.

interface Broadcast {
  id?: string;
  title: string;
  content: string;
  severity: string;
  color?: string;
  startsAt: string;
  endsAt: string;
  filters?: Record<string, any>;
}

function blank(): Broadcast {
  const now = new Date();
  const end = new Date(now.getTime() + 24 * 3600 * 1000);
  return {
    title: '', content: '', severity: 'urgent', color: '',
    startsAt: toLocal(now), endsAt: toLocal(end), filters: {},
  };
}

function toLocal(d: Date) {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmt(s?: string) {
  return s ? new Date(s).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—';
}
function isLive(b: Broadcast) {
  const n = Date.now();
  return new Date(b.startsAt).getTime() <= n && n <= new Date(b.endsAt).getTime();
}

export function AdminBroadcasts() {
  const { t } = useT();
  const [items, setItems] = useState<Broadcast[]>([]);
  const [editing, setEditing] = useState<Broadcast | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try { setItems(await api.listBroadcasts()); }
    finally { setLoading(false); }
  }

  async function save() {
    if (!editing) return;
    if (!editing.title.trim() || !editing.content.trim()) {
      await alertDialog({ title: t('adminBroadcasts.titleMessageRequired'), tone: 'danger' }); return;
    }
    const payload = {
      title: editing.title,
      content: editing.content,
      severity: editing.severity,
      color: editing.color,
      startsAt: new Date(editing.startsAt).toISOString(),
      endsAt: new Date(editing.endsAt).toISOString(),
      filters: { ...(editing.filters || {}), severity: editing.severity, color: editing.color || undefined },
    };
    try {
      if (editing.id) await api.updateBroadcast(editing.id, payload);
      else            await api.createBroadcast(payload);
      setEditing(null);
      load();
    } catch (e: any) { await alertDialog({ title: t('adminBroadcasts.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
  }

  async function remove(b: Broadcast) {
    if (!b.id) return;
    if (!(await confirmDialog({ title: t('adminBroadcasts.confirmDelete', { title: b.title }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteBroadcast(b.id);
    load();
  }

  function edit(b: Broadcast) {
    setEditing({
      ...b,
      startsAt: toLocal(new Date(b.startsAt)),
      endsAt: toLocal(new Date(b.endsAt)),
      color: b.color || b.filters?.color || '',
    });
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminBroadcasts.title')}</h1>
        <button className="btn ghost" onClick={load}><RefreshCcw size={14} /> {t('common.refresh')}</button>
        <button className="btn primary" onClick={() => setEditing(blank())}>
          <Plus size={14} /> {t('adminBroadcasts.new')}
        </button>
      </header>

      {loading ? <p className="muted">{t('common.loading')}</p>
       : items.length === 0 ? (
        <div className="empty">
          <Megaphone size={32} />
          <p>{t('adminBroadcasts.empty')}</p>
        </div>
      ) : (
        <table className="data">
          <thead><tr><th>{t('adminBroadcasts.severity')}</th><th>{t('adminBroadcasts.colTitle')}</th><th>{t('adminBroadcasts.window')}</th><th>{t('common.status')}</th><th></th></tr></thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.id}>
                <td><span className={`pill ${b.severity}`}>{b.severity}</span></td>
                <td>
                  <strong>{b.title}</strong>
                  <div className="muted small">{b.content}</div>
                </td>
                <td className="small">{fmt(b.startsAt)} → {fmt(b.endsAt)}</td>
                <td>{isLive(b) && <span className="pill live">{t('adminBroadcasts.live')}</span>}</td>
                <td>
                  <button className="btn ghost" onClick={() => edit(b)}><Pencil size={14} /></button>
                  <button className="btn danger" onClick={() => remove(b)}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal
          title={editing.id ? t('adminBroadcasts.editTitle') : t('adminBroadcasts.newTitle')}
          onClose={() => setEditing(null)}
          footer={<>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={save}>
              {editing.id ? t('adminBroadcasts.update') : t('adminBroadcasts.publish')}
            </button>
          </>}
        >
          <div className="grid-2">
            <label>{t('adminBroadcasts.severity')}
              <select value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value })}>
                <option value="info">{t('adminBroadcasts.sevInfo')}</option>
                <option value="warning">{t('adminBroadcasts.sevWarning')}</option>
                <option value="urgent">{t('adminBroadcasts.sevUrgent')}</option>
              </select>
            </label>
            <label>{t('adminBroadcasts.bannerColour')}
              <input type="text" placeholder={t('adminBroadcasts.colourPlaceholder')} value={editing.color || ''}
                     onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
            </label>
          </div>
          <label>{t('adminBroadcasts.colTitle')}
            <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                   placeholder="e.g. Typhoon Signal No.8 — Facility Closure" />
          </label>
          <label>{t('adminBroadcasts.message')}
            <textarea rows={4} value={editing.content}
                      onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                      placeholder="All bookings at the affected facilities are suspended until further notice." />
          </label>
          <div className="grid-2">
            <label>{t('adminBroadcasts.startsAt')}
              <input type="datetime-local" value={editing.startsAt}
                     onChange={(e) => setEditing({ ...editing, startsAt: e.target.value })} />
            </label>
            <label>{t('adminBroadcasts.endsAt')}
              <input type="datetime-local" value={editing.endsAt}
                     onChange={(e) => setEditing({ ...editing, endsAt: e.target.value })} />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
