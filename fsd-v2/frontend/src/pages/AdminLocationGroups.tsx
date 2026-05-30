import { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { TokenSelect, TokenOption } from '../components/TokenSelect';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Org-hierarchy room privilege groups. Mirrors v1 AdminLocationGroups.vue.
// approvers / locations / memberIds are arrays the SPA owns. Admins pick
// them from a searchable address book of real users / locations (see
// TokenSelect) rather than hand-typing comma-separated lists.
const blank = { name: '', filterBy: 'Whitelist', status: 'Active', approvers: [] as string[], locations: [] as string[], memberIds: [] as string[] };

function toArr(a: any): string[] { return Array.isArray(a) ? a.map(String) : []; }
function toCsv(a: any[] | undefined) { return Array.isArray(a) ? a.join(', ') : ''; }

export function AdminLocationGroups() {
  const { t } = useT();
  const [items, setItems] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);

  useEffect(() => {
    load();
    api.users().then(setUsers).catch(() => setUsers([]));
    api.locations().then(setLocations).catch(() => setLocations([]));
  }, []);
  function load() { api.locationGroups().then(setItems); }

  // Address-book options. Users are stored by username (the stable, readable
  // identity the table already renders); locations by name.
  const userOptions: TokenOption[] = useMemo(
    () => users.map((u) => ({ value: u.username, label: u.username, sub: u.email || undefined })),
    [users],
  );
  const locationOptions: TokenOption[] = useMemo(
    () => locations.map((l) => ({ value: l.name, label: l.name, sub: l.region || undefined })),
    [locations],
  );

  function open(row: any) {
    setEditing({
      ...row,
      approvers: toArr(row.approvers),
      locations: toArr(row.locations),
      memberIds: toArr(row.memberIds),
    });
  }

  async function save() {
    try {
      const body = {
        ...editing,
        approvers: toArr(editing.approvers),
        locations: toArr(editing.locations),
        memberIds: toArr(editing.memberIds),
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
          <label>{t('adminLocationGroups.locations')}
            <TokenSelect options={locationOptions} value={editing.locations}
              onChange={(v) => setEditing({ ...editing, locations: v })}
              placeholder={t('adminLocationGroups.locationsPlaceholder')}
              emptyText={t('adminLocationGroups.noLocations')} />
          </label>
          <label>{t('adminLocationGroups.approvers')}
            <TokenSelect options={userOptions} value={editing.approvers}
              onChange={(v) => setEditing({ ...editing, approvers: v })}
              placeholder={t('adminLocationGroups.usersPlaceholder')}
              emptyText={t('adminLocationGroups.noUsers')} allowCustom />
          </label>
          <label>{t('adminLocationGroups.members')}
            <TokenSelect options={userOptions} value={editing.memberIds}
              onChange={(v) => setEditing({ ...editing, memberIds: v })}
              placeholder={t('adminLocationGroups.usersPlaceholder')}
              emptyText={t('adminLocationGroups.noUsers')} allowCustom />
          </label>
        </Modal>
      )}
    </div>
  );
}
