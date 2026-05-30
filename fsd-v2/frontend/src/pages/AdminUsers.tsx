import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

// Mirrors v1's AdminUsers.vue including the multi-select Departments
// section — the v2 backend persists membership through the same M2M
// join table, with the same tenant-scoped intersection guard.
export function AdminUsers() {
  const { t } = useT();
  const [users, setUsers] = useState<any[]>([]);
  const [depts, setDepts] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); api.departments().then(setDepts).catch(() => {}); }, []);
  function load() { api.users().then(setUsers); }

  function openNew() {
    setEditing({ username: '', role: 'General User', password: '', regionAccess: [], departmentIds: [], isActive: true, mustChangePassword: true });
  }
  function open(u: any) {
    setEditing({ ...u, password: '', departmentIds: (u.departments || []).map((d: any) => d.id) });
  }
  function toggleDept(id: string) {
    setEditing((e: any) => {
      const s = new Set<string>(e.departmentIds || []);
      s.has(id) ? s.delete(id) : s.add(id);
      return { ...e, departmentIds: [...s] };
    });
  }
  async function save() {
    setBusy(true);
    try {
      if (editing.id) await api.updateUser(editing.id, editing);
      else            await api.createUser(editing);
      setEditing(null); load();
    } catch (e: any) { await alertDialog({ title: t('adminUsers.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
    finally { setBusy(false); }
  }
  async function deactivate() {
    if (!(await confirmDialog({ title: t('adminUsers.deactivateConfirm'), tone: 'danger', confirmText: t('common.confirm'), cancelText: t('common.cancel') }))) return;
    setBusy(true);
    try { await api.deactivateUser(editing.id); setEditing(null); load(); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminUsers.title')}</h1>
        <button className="btn primary" onClick={openNew}>+ {t('adminUsers.newUser')}</button>
      </header>

      <table className="data">
        <thead><tr><th>{t('adminUsers.username')}</th><th>{t('adminUsers.role')}</th><th>{t('adminUsers.regions')}</th><th>{t('adminUsers.departments')}</th><th>{t('common.status')}</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.username}</td>
              <td><span className="tag">{u.role}</span></td>
              <td className="muted">{(u.regionAccess || []).join(', ') || '—'}</td>
              <td className="muted">{(u.departments || []).map((d: any) => d.name).join(', ') || '—'}</td>
              <td><span className={`tag ${u.isActive ? 'ok' : 'bad'}`}>{u.isActive ? t('common.active') : t('common.inactive')}</span></td>
              <td><button className="btn ghost" onClick={() => open(u)}>{t('adminUsers.edit')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {editing && (
        <Modal
          title={editing.id ? t('adminUsers.editUser', { name: editing.username }) : t('adminUsers.createUser')}
          onClose={() => setEditing(null)}
          footer={<>
            {editing.id && <button className="btn danger" disabled={busy} onClick={deactivate}>{t('adminUsers.deactivate')}</button>}
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={save}>{t('common.save')}</button>
          </>}
        >
          <div className="grid-2">
            <label>{t('adminUsers.username')}<input value={editing.username || ''} onChange={(e) => setEditing({ ...editing, username: e.target.value })} /></label>
            <label>{t('adminUsers.role')}
              <select value={editing.role || ''} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                <option>System Admin</option><option>Security Admin</option><option>Room Admin</option>
                <option>Secretary</option><option>General User</option>
              </select>
            </label>
            <label>{editing.id ? t('adminUsers.password') : t('adminUsers.initialPassword')} {editing.id && <span className="muted">{t('adminUsers.passwordKeepHint')}</span>}
              <input type="password" value={editing.password || ''} autoComplete="new-password"
                onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </label>
            <label>{t('adminUsers.grade')}<input value={editing.grade || ''} onChange={(e) => setEditing({ ...editing, grade: e.target.value })} placeholder="SDO / DGFS / …" /></label>
          </div>

          <label className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={!!editing.mustChangePassword}
              onChange={(e) => setEditing({ ...editing, mustChangePassword: e.target.checked })} />
            <span>{t('adminUsers.forceReset')}</span>
          </label>
          <label>{t('adminUsers.regionAccess')}
            <input value={(editing.regionAccess || []).join(', ')}
              onChange={(e) => setEditing({ ...editing, regionAccess: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} />
          </label>

          <div className="field">
            <label>{t('adminUsers.departments')}</label>
            {!depts.length && <p className="muted">{t('adminUsers.noDepartments')}</p>}
            <div className="dep-grid">
              {depts.map((d) => (
                <label key={d.id} className="dep-chip">
                  <input type="checkbox" checked={(editing.departmentIds || []).includes(d.id)} onChange={() => toggleDept(d.id)} />
                  {d.name}{d.code && <span className="muted"> · {d.code}</span>}
                </label>
              ))}
            </div>
          </div>

          <label className="row">
            <input type="checkbox" checked={!!editing.isActive} onChange={(e) => setEditing({ ...editing, isActive: e.target.checked })} />
            <span>{t('adminUsers.activeAccount')}</span>
          </label>
        </Modal>
      )}
    </div>
  );
}
