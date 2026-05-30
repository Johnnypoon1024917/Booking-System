import { useEffect, useState } from 'react';
import { CalendarDays, Download, Plus, RefreshCcw, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Admin holidays page. List + add/delete + a "Sync HK" button that
// pulls the live gov.hk feed (used as the manual trigger; a nightly
// cron also runs server-side at 03:00).

interface Holiday {
  id?: string;
  holidayDate: string;
  name: string;
  scope?: string;
  // '' = tenant-wide; otherwise only blocks resources in this region.
  region?: string;
  isBlocker?: boolean;
}

function blank(): Holiday {
  // 'en-CA' yields YYYY-MM-DD in the *local* calendar. toISOString() would use
  // UTC, so an admin in Asia opening this before 08:00 would default to
  // yesterday (UTC is still the previous day).
  return { holidayDate: new Date().toLocaleDateString('en-CA'), name: '', isBlocker: true, scope: 'manual', region: '' };
}

export function AdminHolidays() {
  const { t } = useT();
  const [items, setItems] = useState<Holiday[]>([]);
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); loadRegions(); }, []);

  async function load() {
    setLoading(true);
    try { setItems(await api.listHolidays()); }
    finally { setLoading(false); }
  }

  // Regions are free-form strings on resources (no fixed enum), so derive the
  // pick-list from the distinct regions actually in use. Drives the "Applies
  // to" scope picker — a holiday scoped to a region only blocks its rooms.
  async function loadRegions() {
    try {
      const res: Array<{ region?: string }> = await api.adminResources();
      setRegions([...new Set(res.map((r) => r.region).filter((r): r is string => !!r))].sort());
    } catch { /* picker falls back to tenant-wide only */ }
  }

  async function save() {
    if (!editing) return;
    try {
      if (editing.id) await api.updateHoliday(editing.id, editing);
      else            await api.createHoliday(editing);
      setEditing(null);
      load();
    } catch (e: any) { await alertDialog({ title: t('common.error'), message: e.displayMessage, tone: 'danger' }); }
  }

  async function remove(h: Holiday) {
    if (!h.id) return;
    if (!(await confirmDialog({ title: t('adminHolidays.confirmDelete', { name: h.name || h.holidayDate }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteHoliday(h.id);
    load();
  }

  async function syncHK() {
    setSyncing(true);
    try {
      const res = await api.syncHKHolidays('en');
      await alertDialog({ title: t('adminHolidays.syncResult', { imported: res.imported, skipped: res.skipped }) });
      load();
    } catch (e: any) {
      await alertDialog({ title: t('adminHolidays.syncFailed'), message: e.displayMessage, tone: 'danger' });
    } finally { setSyncing(false); }
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminHolidays.title')}</h1>
        <button className="btn ghost" onClick={load}><RefreshCcw size={14} /> {t('common.refresh')}</button>
        <button className="btn ghost" onClick={syncHK} disabled={syncing}>
          <Download size={14} /> {syncing ? t('adminHolidays.syncing') : t('adminHolidays.syncGovhk')}
        </button>
        <button className="btn primary" onClick={() => setEditing(blank())}>
          <Plus size={14} /> {t('adminHolidays.add')}
        </button>
      </header>

      {loading ? <p className="muted">{t('common.loading')}</p>
       : items.length === 0 ? (
        <div className="empty">
          <CalendarDays size={32} />
          <p>{t('adminHolidays.empty')}</p>
        </div>
      ) : (
        <table className="data">
          <thead><tr><th>{t('adminHolidays.colDate')}</th><th>{t('adminHolidays.colName')}</th><th>{t('adminHolidays.colScope')}</th><th>{t('adminHolidays.colAppliesTo')}</th><th>{t('adminHolidays.colBlocks')}</th><th></th></tr></thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id}>
                <td>{h.holidayDate}</td>
                <td>{h.name || <span className="muted">—</span>}</td>
                <td className="small muted">{h.scope || 'manual'}</td>
                <td className="small">{h.region || <span className="muted">{t('adminHolidays.tenantWide')}</span>}</td>
                <td>{h.isBlocker ? t('common.yes') : t('common.no')}</td>
                <td>
                  <button className="btn ghost" onClick={() => setEditing({ ...h })}>{t('adminHolidays.edit')}</button>
                  <button className="btn danger" onClick={() => remove(h)}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <Modal
          title={editing.id ? t('adminHolidays.editTitle') : t('adminHolidays.addTitle')}
          onClose={() => setEditing(null)}
          footer={<>
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn primary" onClick={save}>{t('common.save')}</button>
          </>}
        >
          <label>{t('adminHolidays.colDate')}
            <input type="date" value={editing.holidayDate}
                   onChange={(e) => setEditing({ ...editing, holidayDate: e.target.value })} />
          </label>
          <label>{t('adminHolidays.colName')}
            <input value={editing.name}
                   onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                   placeholder="e.g. Lunar New Year" />
          </label>
          <label>{t('adminHolidays.colAppliesTo')}
            <select value={editing.region || ''} onChange={(e) => setEditing({ ...editing, region: e.target.value })}>
              <option value="">{t('adminHolidays.tenantWide')}</option>
              {/* Keep the current value selectable even if no resource uses it yet. */}
              {editing.region && !regions.includes(editing.region) && (
                <option value={editing.region}>{editing.region}</option>
              )}
              {regions.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <small className="muted">{t('adminHolidays.appliesToHelp')}</small>
          </label>
          <label className="row">
            <input type="checkbox" checked={!!editing.isBlocker}
                   onChange={(e) => setEditing({ ...editing, isBlocker: e.target.checked })} />
            {t('adminHolidays.blockNew')}
          </label>
        </Modal>
      )}
    </div>
  );
}
