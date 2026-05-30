import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';

// Visitor management: pre-register guests, then check them in/out at
// reception. Mirrors v1 AdminVisitors.vue. Lifecycle:
//   Expected -> Checked In -> Checked Out, with Cancelled / No Show
//   as terminal states.
export function AdminVisitors() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [editing, setEditing] = useState<any | null>(null);

  useEffect(() => { load(); api.users().then(setUsers); }, [statusFilter]);
  function load() { api.visitors(statusFilter ? { status: statusFilter } : undefined).then(setItems); }

  function open(row?: any) {
    setEditing(row ? { ...row,
      expectedAt: row.expectedAt ? new Date(row.expectedAt).toISOString().slice(0, 16) : '',
      expectedUntil: row.expectedUntil ? new Date(row.expectedUntil).toISOString().slice(0, 16) : '',
    } : { visitorName: '', hostUserId: '', expectedAt: '', purpose: '' });
  }
  async function save() {
    const body = { ...editing,
      expectedAt: new Date(editing.expectedAt).toISOString(),
      expectedUntil: editing.expectedUntil ? new Date(editing.expectedUntil).toISOString() : undefined,
    };
    try {
      if (editing.id) await api.updateVisitor(editing.id, body);
      else            await api.createVisitor(body);
      setEditing(null); load();
    } catch (e: any) { alert(e.displayMessage || t('common.error')); }
  }
  async function lifecycle(v: any, action: 'check-in' | 'check-out' | 'cancel') {
    try {
      if (action === 'check-in') await api.checkInVisitor(v.id);
      else if (action === 'check-out') await api.checkOutVisitor(v.id);
      else await api.cancelVisitor(v.id);
      load();
    } catch (e: any) { alert(e.displayMessage || t('adminVisitors.actionFailed')); }
  }
  async function remove(v: any) {
    if (!confirm(t('adminVisitors.confirmDelete', { name: v.visitorName }))) return;
    await api.deleteVisitor(v.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminVisitors.title')}</h1>
        <select aria-label={t('adminVisitors.allStatuses')} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">{t('adminVisitors.allStatuses')}</option>
          <option value="Expected">{t('adminVisitors.statusExpected')}</option>
          <option value="Checked In">{t('adminVisitors.statusCheckedIn')}</option>
          <option value="Checked Out">{t('adminVisitors.statusCheckedOut')}</option>
          <option value="No Show">{t('adminVisitors.statusNoShow')}</option>
          <option value="Cancelled">{t('adminVisitors.statusCancelled')}</option>
        </select>
        <button className="btn primary" onClick={() => open()}>+ {t('adminVisitors.register')}</button>
      </header>

      <table className="data">
        <thead><tr><th>{t('adminVisitors.colVisitor')}</th><th>{t('adminVisitors.colHost')}</th><th>{t('adminVisitors.colExpected')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {items.map((v) => (
            <tr key={v.id}>
              <td>{v.visitorName}{v.visitorCompany && <em style={{ color: 'var(--text-dim)' }}> · {v.visitorCompany}</em>}</td>
              <td>{users.find((u) => u.id === v.hostUserId)?.username || v.hostUserId}</td>
              <td>{new Date(v.expectedAt).toLocaleString()}</td>
              <td><span className="tag">{v.status}</span></td>
              <td>
                {v.status === 'Expected' && <button className="btn ghost" onClick={() => lifecycle(v, 'check-in')}>{t('adminVisitors.checkIn')}</button>}
                {v.status === 'Checked In' && <button className="btn ghost" onClick={() => lifecycle(v, 'check-out')}>{t('adminVisitors.checkOut')}</button>}
                {(v.status === 'Expected' || v.status === 'Checked In') && <button className="btn ghost" onClick={() => lifecycle(v, 'cancel')}>{t('common.cancel')}</button>}
                <button className="btn ghost" onClick={() => open(v)}>{t('adminVisitors.edit')}</button>
                <button className="btn danger" onClick={() => remove(v)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? t('adminVisitors.editVisit', { name: editing.visitorName }) : t('adminVisitors.register')} onClose={() => setEditing(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
          <div className="grid-2">
            <label>{t('adminVisitors.visitorName')}<input value={editing.visitorName} onChange={(e) => setEditing({ ...editing, visitorName: e.target.value })} /></label>
            <label>{t('adminVisitors.company')}<input value={editing.visitorCompany || ''} onChange={(e) => setEditing({ ...editing, visitorCompany: e.target.value })} /></label>
            <label>{t('adminVisitors.email')}<input value={editing.visitorEmail || ''} onChange={(e) => setEditing({ ...editing, visitorEmail: e.target.value })} /></label>
            <label>{t('adminVisitors.phone')}<input value={editing.visitorPhone || ''} onChange={(e) => setEditing({ ...editing, visitorPhone: e.target.value })} /></label>
            <label>{t('adminVisitors.host')}
              <select value={editing.hostUserId} onChange={(e) => setEditing({ ...editing, hostUserId: e.target.value })}>
                <option value="">—</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </label>
            <label>{t('adminVisitors.purpose')}<input value={editing.purpose || ''} onChange={(e) => setEditing({ ...editing, purpose: e.target.value })} /></label>
            <label>{t('adminVisitors.expectedAt')}<input type="datetime-local" value={editing.expectedAt} onChange={(e) => setEditing({ ...editing, expectedAt: e.target.value })} /></label>
            <label>{t('adminVisitors.expectedUntil')}<input type="datetime-local" value={editing.expectedUntil || ''} onChange={(e) => setEditing({ ...editing, expectedUntil: e.target.value })} /></label>
          </div>
          <label className="row"><input type="checkbox" checked={!!editing.ndaAccepted} onChange={(e) => setEditing({ ...editing, ndaAccepted: e.target.checked })} /> {t('adminVisitors.ndaAccepted')}</label>
          <label>{t('adminVisitors.notes')}<textarea rows={2} value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} /></label>
        </Modal>
      )}
    </div>
  );
}��