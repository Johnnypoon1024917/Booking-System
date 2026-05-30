import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Catering / AV / equipment add-ons. Price is stored as integer cents
// to avoid float drift — the UI converts to/from major units.
const blank = { name: '', description: '', priceCents: 0, isActive: true };

export function AdminServices() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [priceText, setPriceText] = useState('0.00');

  useEffect(() => { load(); }, []);
  function load() { api.adminServices().then(setItems); }

  function open(row: any) {
    setEditing({ ...row });
    setPriceText(((row.priceCents ?? 0) / 100).toFixed(2));
  }
  async function save() {
    const cents = Math.round(parseFloat(priceText || '0') * 100);
    const body = { ...editing, priceCents: isFinite(cents) ? cents : 0 };
    try {
      if (editing.id) await api.updateService(editing.id, body);
      else            await api.createService(body);
      setEditing(null); load();
    } catch (e: any) { await alertDialog({ title: t('adminServices.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function remove(r: any) {
    if (!(await confirmDialog({ title: t('adminServices.confirmDelete', { name: r.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteService(r.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminServices.title')}</h1>
        <button className="btn primary" onClick={() => open({ ...blank })}>{t('adminServices.add')}</button>
      </header>
      <table className="data">
        <thead><tr><th>{t('adminServices.name')}</th><th>{t('adminServices.description')}</th><th>{t('adminServices.price')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.description || '—'}</td>
              <td>{(r.priceCents / 100).toFixed(2)}</td>
              <td><span className={`tag ${r.isActive ? 'ok' : 'bad'}`}>{r.isActive ? t('common.active') : t('common.inactive')}</span></td>
              <td>
                <button className="btn ghost" onClick={() => open(r)}>{t('adminServices.edit')}</button>
                <button className="btn danger" onClick={() => remove(r)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? t('adminServices.editTitle', { name: editing.name }) : t('adminServices.add')} onClose={() => setEditing(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
          <div className="grid-2">
            <label>{t('adminServices.name')}<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>{t('adminServices.priceMajor')}
              <input type="number" min={0} step="0.01" value={priceText} onChange={(e) => setPriceText(e.target.value)} />
            </label>
          </div>
          <label>{t('adminServices.description')}
            <textarea rows={3} value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </label>
          <label className="row"><input type="checkbox" checked={!!editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> {t('common.active')}</label>
        </Modal>
      )}
    </div>
  );
}
