import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Admin-extensible asset type catalog. Built-ins (`isBuiltin`) show as
// locked rows. Mirrors v1 AdminResourceTypes.vue.
const blank = {
  key: '', label: '', icon: 'box', color: '#3b82f6',
  defaultCapacity: 0, defaultBookingMode: 'exclusive',
  defaultRequiresApproval: false, displayOrder: 0, isActive: true,
};

export function AdminResourceTypes() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  useEffect(() => { load(); }, []);
  function load() { api.adminResourceTypes().then(setItems); }

  async function save() {
    try {
      if (editing.id) await api.updateResourceType(editing.id, editing);
      else            await api.createResourceType(editing);
      setEditing(null); load();
    } catch (e: any) { await alertDialog({ title: t('adminResourceTypes.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function remove(r: any) {
    if (r.isBuiltin) { await alertDialog({ title: t('adminResourceTypes.builtinCannotDelete'), tone: 'danger' }); return; }
    if (!(await confirmDialog({ title: t('adminResourceTypes.deleteConfirm', { name: r.label }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteResourceType(r.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminResourceTypes.title')}</h1>
        <button className="btn primary" onClick={() => setEditing({ ...blank })}>+ {t('adminResourceTypes.addType')}</button>
      </header>
      <table className="data">
        <thead><tr><th>{t('adminResourceTypes.key')}</th><th>{t('adminResourceTypes.label')}</th><th>{t('adminResourceTypes.icon')}</th><th>{t('adminResourceTypes.color')}</th><th>{t('adminResourceTypes.defaultCap')}</th><th>{t('adminResourceTypes.mode')}</th><th>{t('adminResourceTypes.approval')}</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td><code>{r.key}</code>{r.isBuiltin && <span className="tag" style={{ marginLeft: 6 }}>{t('adminResourceTypes.builtin')}</span>}</td>
              <td>{r.label}</td>
              <td>{r.icon}</td>
              <td><span style={{ display: 'inline-block', width: 16, height: 16, background: r.color, borderRadius: 3, verticalAlign: 'middle' }}/> {r.color}</td>
              <td>{r.defaultCapacity}</td>
              <td>{r.defaultBookingMode}</td>
              <td>{r.defaultRequiresApproval ? t('common.yes') : t('common.no')}</td>
              <td>
                <button className="btn ghost" onClick={() => setEditing({ ...r })}>{t('adminResourceTypes.edit')}</button>
                <button className="btn danger" onClick={() => remove(r)} disabled={r.isBuiltin}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? t('adminResourceTypes.editType', { name: editing.label }) : t('adminResourceTypes.addType')} onClose={() => setEditing(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
          <div className="grid-2">
            <label>{t('adminResourceTypes.key')}<input value={editing.key} onChange={(e) => setEditing({ ...editing, key: e.target.value })} disabled={editing.isBuiltin} /></label>
            <label>{t('adminResourceTypes.label')}<input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></label>
            <label>{t('adminResourceTypes.iconLucide')}<input value={editing.icon} onChange={(e) => setEditing({ ...editing, icon: e.target.value })} /></label>
            <label>{t('adminResourceTypes.color')}
              <div className="row gap-sm">
                <input type="color" value={editing.color} onChange={(e) => setEditing({ ...editing, color: e.target.value })} />
                <input type="text" value={editing.color} maxLength={7} placeholder="#3b82f6"
                  onChange={(e) => setEditing({ ...editing, color: e.target.value })} style={{ flex: 1 }} />
              </div>
            </label>
            <label>{t('adminResourceTypes.defaultCapacity')}<input type="number" min={0} value={editing.defaultCapacity} onChange={(e) => setEditing({ ...editing, defaultCapacity: +e.target.value })} /></label>
            <label>{t('adminResourceTypes.displayOrder')}<input type="number" value={editing.displayOrder} onChange={(e) => setEditing({ ...editing, displayOrder: +e.target.value })} /></label>
            <label>{t('adminResourceTypes.bookingMode')}
              <select value={editing.defaultBookingMode} onChange={(e) => setEditing({ ...editing, defaultBookingMode: e.target.value })}>
                <option value="exclusive">{t('adminResourceTypes.modeExclusive')}</option>
                <option value="shared">{t('adminResourceTypes.modeShared')}</option>
              </select>
            </label>
          </div>
          <label className="row"><input type="checkbox" checked={!!editing.defaultRequiresApproval} onChange={(e) => setEditing({ ...editing, defaultRequiresApproval: e.target.checked })} /> {t('adminResourceTypes.requiresApprovalDefault')}</label>
          <label className="row"><input type="checkbox" checked={!!editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} /> {t('common.active')}</label>
        </Modal>
      )}
    </div>
  );
}
