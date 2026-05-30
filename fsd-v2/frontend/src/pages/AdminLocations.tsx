import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// First-class admin location catalog. Matches v1 AdminLocations.vue.
// Address is a freeform JSONB blob — surfaced here as a multi-line
// JSON textarea so admins with structured data can store it, but most
// will just leave it empty and use the name + region.
const blank = { name: '', region: '', address: {} };

export function AdminLocations() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [addrText, setAddrText] = useState('');

  useEffect(() => { load(); }, []);
  function load() { api.adminLocations().then(setItems); }

  function open(row: any) {
    setEditing({ ...row });
    setAddrText(row.address ? JSON.stringify(row.address, null, 2) : '');
  }

  async function save() {
    try {
      let address: any = {};
      if (addrText.trim()) {
        try { address = JSON.parse(addrText); } catch { await alertDialog({ title: t('adminLocations.invalidJson'), tone: 'danger' }); return; }
      }
      const body = { ...editing, address };
      if (editing.id) await api.updateLocation(editing.id, body);
      else            await api.createLocation(body);
      setEditing(null); load();
    } catch (e: any) { await alertDialog({ title: t('adminLocations.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function remove(r: any) {
    if (!(await confirmDialog({ title: t('adminLocations.confirmDelete', { name: r.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteLocation(r.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminLocations.title')}</h1>
        <button className="btn primary" onClick={() => open({ ...blank })}>{t('adminLocations.add')}</button>
      </header>
      <table className="data">
        <thead><tr><th>{t('adminLocations.name')}</th><th>{t('adminLocations.region')}</th><th>{t('adminLocations.address')}</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.region || '—'}</td>
              <td><code style={{ fontSize: 11 }}>{r.address && Object.keys(r.address).length ? JSON.stringify(r.address) : '—'}</code></td>
              <td>
                <button className="btn ghost" onClick={() => open(r)}>{t('adminLocations.edit')}</button>
                <button className="btn danger" onClick={() => remove(r)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? t('adminLocations.editTitle', { name: editing.name }) : t('adminLocations.add')} onClose={() => setEditing(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
          <div className="grid-2">
            <label>{t('adminLocations.name')}<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>{t('adminLocations.region')}<input value={editing.region || ''} onChange={(e) => setEditing({ ...editing, region: e.target.value })} /></label>
          </div>
          <label>{t('adminLocations.addressJson')}
            <textarea rows={5} value={addrText} onChange={(e) => setAddrText(e.target.value)}
              placeholder='{ "street": "...", "city": "...", "postal": "..." }' />
          </label>
        </Modal>
      )}
    </div>
  );
}
