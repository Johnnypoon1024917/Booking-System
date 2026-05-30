import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Org-hierarchy room privilege groups. Mirrors v1 AdminLocationGroups.vue.
// approvers / locations / memberIds are arrays the SPA owns; we surface
// them as comma-separated chips for the simple case.
const blank = { name: '', filterBy: 'Whitelist', status: 'Active', approvers: [] as string[], locations: [] as string[], memberIds: [] as string[] };

function toCsv(a: any[] | undefined) { return Array.isArray(a) ? a.join(', ') : ''; }
function fromCsv(s: string) { return s.split(',').map((x) => x.trim()).filter(Boolean); }

export function AdminLocationGroups() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [approversText, setApproversText] = useState('');
  const [locationsText, setLocationsText] = useState('');
  const [membersText, setMembersText] = useState('');

  useEffect(() => { load(); }, []);
  function load() { api.locationGroups().then(setItems); }

  function open(row: any) {
    setEditing({ ...row });
    setApproversText(toCsv(row.approvers));
    setLocationsText(toCsv(row.locations));
    setMembersText(toCsv(row.memberIds));
  }

  async function save() {
    try {
      const body = {
        ...editing,
        approvers: fromCsv(approversText),
        locations: fromCsv(locationsText),
        memberIds: fromCsv(membersText),
      };
      if (editing.id) await api.updateLocationGroup(editing.id, body);
      else            await api.createLocationGroup(body);
      setEditing(null); load();
    } catch (e: any) { await alertDialog({ title: t('adminLocationGroups.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
  }
  async function remove(r: any) {
    if (!(await confirmDialog({ title: t('adminLocationGroups.confirmDelete', { name: r.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    await api.deleteLocationGroup(r.id); load();
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminLocationGroups.title')}</h1>
        <button className="btn primary" onClick={() => open({ ...blank })}>{t('adminLocationGroups.add')}</button>
      </header>
      <table className="data">
        <thead><tr><th>{t('adminLocationGroups.name')}</th><th>{t('adminLocationGroups.filter')}</th><th>{t('adminLocationGroups.locations')}</th><th>{t('adminLocationGroups.approvers')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {items.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.filterBy}</td>
              <td>{toCsv(r.locations) || '—'}</td>
              <td>{toCsv(r.approvers) || '—'}</td>
              <td><span className={`tag ${r.status === 'Active' ? 'ok' : 'bad'}`}>{r.status}</span></td>
              <td>
                <button className="btn ghost" onClick={() => open(r)}>{t('adminLocationGroups.edit')}</button>
                <button className="btn danger" onClick={() => remove(r)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal title={editing.id ? t('adminLocationGroups.editTitle', { name: editing.name }) : t('adminLocationGroups.add')} onClose={() => setEditing(null)}
          footer={<><span className="spacer"/><button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button><button className="btn primary" onClick={save}>{t('common.save')}</button></>}>
          <div className="grid-2">
            <label>{t('adminLocationGroups.name')}<input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></label>
            <label>{t('adminLocationGroups.filterBy')}
              <select value={editing.filterBy} onChange={(e) => setEditing({ ...editing, filterBy: e.target.value })}>
                <option>Whitelist</option><option>Channel</option><option>Department</option>
              </select>
            </label>
            <label>{t('common.status')}
              <select value={editing.status} onChange={(e) => setEditing({ ...editing, status: e.target.value })}>
                <option>Active</option><option>Inactive</option>
              </select>
            </label>
          </div>
          <label>{t('adminLocationGroups.locationsCsv')}
            <input value={locationsText} onChange={(e) => setLocationsText(e.target.value)} />
          </label>
          <label>{t('adminLocationGroups.approversCsv')}
            <input value={approversText} onChange={(e) => setApproversText(e.target.value)} />
          </label>
          <label>{t('adminLocationGroups.memberIdsCsv')}
            <input value={membersText} onChange={(e) => setMembersText(e.target.value)} />
          </label>
        </Modal>
      )}
    </div>
  );
}
