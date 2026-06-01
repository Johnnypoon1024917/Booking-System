import { useEffect, useRef, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { confirmDialog, alertDialog } from '../stores/confirm';

const PAGE_SIZE = 25;

// Async typeahead for the line manager. Mirrors the delegate picker in
// Approvals — queries the capped server-side directory search instead of
// rendering every user as a <select> option, which freezes on a large
// (government-scale) tenant. `initialLabel` seeds the current manager's
// name when editing so the field isn't blank for an already-set manager.
function ManagerPicker({ initialLabel, onSelect, placeholder }:
  { initialLabel: string; onSelect: (id: string) => void; placeholder: string }) {
  const { t } = useT();
  const [text, setText] = useState(initialLabel);
  const [results, setResults] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    const h = setTimeout(async () => {
      try { const r = await api.searchApprovers(text); if (active) setResults(r || []); }
      catch { if (active) setResults([]); }
      finally { if (active) setLoading(false); }
    }, 250);
    return () => { active = false; clearTimeout(h); };
  }, [text, open]);

  useEffect(() => {
    function onDoc(e: MouseEvent) { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  function pick(u: any) {
    setText(`${u.username}${u.role ? ` — ${u.role}` : ''}`);
    onSelect(u.id);
    setOpen(false);
  }
  function clear() { setText(''); onSelect(''); setResults([]); }

  return (
    <div className="typeahead" ref={boxRef}>
      <div className="typeahead-input">
        <Search size={14} className="muted" />
        <input
          value={text}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          // Editing after a pick invalidates the selection so a stale id
          // can't be submitted under a different visible name.
          onChange={(e) => { setText(e.target.value); onSelect(''); setOpen(true); }}
        />
        {text && <button type="button" className="btn ghost xs" onClick={clear}>×</button>}
      </div>
      {open && (
        <div className="typeahead-menu">
          {loading && <div className="typeahead-empty muted text-sm">{t('common.loading')}</div>}
          {!loading && results.length === 0 && <div className="typeahead-empty muted text-sm">{t('approvals.noMatches')}</div>}
          {!loading && results.map((u) => (
            <button type="button" key={u.id} className="typeahead-item" onClick={() => pick(u)}>
              <b>{u.username}</b>
              {u.role && <span className="muted"> — {u.role}</span>}
              {u.grade && <span className="muted"> · {u.grade}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Mirrors v1's AdminUsers.vue including the multi-select Departments
// section — the v2 backend persists membership through the same M2M
// join table, with the same tenant-scoped intersection guard.
export function AdminUsers() {
  const { t } = useT();
  const [users, setUsers] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [depts, setDepts] = useState<any[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  // Assignable roles — fetched from the permissions matrix so a custom role
  // ("Catering Staff", "IT Support") an admin defines in AdminPermissions is
  // immediately selectable here, instead of a hardcoded built-in list.
  const [roles, setRoles] = useState<string[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  // Reference data — departments, the canonical region list (derived from
  // configured locations so admins pick from real values instead of free-typing
  // comma-separated strings that silently break RLS), and the role catalogue.
  useEffect(() => {
    api.departments().then(setDepts).catch(() => {});
    api.locations()
      .then((locs: any[]) => setRegions([...new Set((locs || []).map((l) => l.region).filter(Boolean))].sort()))
      .catch(() => {});
    api.getPermissions()
      .then((d: any) => setRoles(Object.keys(d?.roles ?? {}).sort()))
      .catch(() => {});
  }, []);

  // Debounced server-side load. Editing `search` resets to page 1 so the
  // user always sees the first page of matches.
  useEffect(() => {
    let active = true;
    const h = setTimeout(() => {
      api.usersPaged({ page, pageSize: PAGE_SIZE, search: search.trim() })
        .then((r) => { if (active) { setUsers(r.items || []); setTotal(r.total || 0); } })
        .catch(() => { if (active) { setUsers([]); setTotal(0); } });
    }, 200);
    return () => { active = false; clearTimeout(h); };
  }, [page, search]);

  function reload() {
    api.usersPaged({ page, pageSize: PAGE_SIZE, search: search.trim() })
      .then((r) => { setUsers(r.items || []); setTotal(r.total || 0); })
      .catch(() => {});
  }
  function onSearch(v: string) { setSearch(v); setPage(1); }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function openNew() {
    setEditing({ username: '', role: 'General User', password: '', regionAccess: [], departmentIds: [], isActive: true, mustChangePassword: true });
  }
  function open(u: any) {
    // password starts blank; save() strips it unless the admin types a new
    // one, so we never transmit an empty password for an existing user.
    setEditing({
      ...u,
      password: '',
      departmentIds: (u.departments || []).map((d: any) => d.id),
      regionAccess: u.regionAccess || [],
    });
  }
  function toggleDept(id: string) {
    setEditing((e: any) => {
      const s = new Set<string>(e.departmentIds || []);
      s.has(id) ? s.delete(id) : s.add(id);
      return { ...e, departmentIds: [...s] };
    });
  }
  function toggleRegion(region: string) {
    setEditing((e: any) => {
      const s = new Set<string>(e.regionAccess || []);
      s.has(region) ? s.delete(region) : s.add(region);
      return { ...e, regionAccess: [...s] };
    });
  }
  async function save() {
    setBusy(true);
    try {
      // Never transmit an empty password for an existing user — strip it so
      // a backend regression could never blank a stored credential.
      const payload = { ...editing };
      if (!payload.password) delete payload.password;
      delete payload.managerName; // display-only field, not part of the DTO
      if (editing.id) await api.updateUser(editing.id, payload);
      else            await api.createUser(payload);
      setEditing(null); reload();
    } catch (e: any) { await alertDialog({ title: t('adminUsers.saveFailed'), message: e.displayMessage, tone: 'danger' }); }
    finally { setBusy(false); }
  }
  async function deactivate() {
    if (!(await confirmDialog({ title: t('adminUsers.deactivateConfirm'), tone: 'danger', confirmText: t('common.confirm'), cancelText: t('common.cancel') }))) return;
    setBusy(true);
    try { await api.deactivateUser(editing.id); setEditing(null); reload(); }
    finally { setBusy(false); }
  }

  // Regions to render as checkboxes: the configured location regions plus
  // any already on this user that aren't in that list (so editing never
  // silently drops a legacy value).
  const editRegions = editing
    ? [...new Set([...regions, ...(editing.regionAccess || [])])].sort()
    : [];

  // Always include the user's current role even if it's not in the fetched
  // list (e.g. a legacy role, or the matrix failed to load) so editing never
  // silently changes a user's role to the first option.
  const roleOptions = editing
    ? [...new Set([...roles, editing.role].filter(Boolean))]
    : roles;

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminUsers.title')}</h1>
        <button className="btn primary" onClick={openNew}>+ {t('adminUsers.newUser')}</button>
      </header>

      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="typeahead-input" style={{ maxWidth: 360 }}>
          <Search size={14} className="muted" />
          <input
            value={search}
            placeholder={t('adminUsers.searchPlaceholder')}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      </div>

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
          {users.length === 0 && (
            <tr><td colSpan={6} className="muted" style={{ textAlign: 'center', padding: 24 }}>{t('adminUsers.noResults')}</td></tr>
          )}
        </tbody>
      </table>

      <div className="pager" style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
        <span className="muted">{t('adminUsers.totalCount', { count: total })}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn ghost" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          <ChevronLeft size={14} /> {t('common.prev')}
        </button>
        <span className="muted">{t('adminUsers.pageOf', { page, pages: pageCount })}</span>
        <button className="btn ghost" disabled={page >= pageCount} onClick={() => setPage((p) => Math.min(pageCount, p + 1))}>
          {t('common.next')} <ChevronRight size={14} />
        </button>
      </div>

      {editing && (
        <Modal
          title={editing.id ? t('adminUsers.editUser', { name: editing.username }) : t('adminUsers.createUser')}
          onClose={() => setEditing(null)}
          footer={<>
            {editing.id && <button className="btn danger" disabled={busy} onClick={deactivate}>{t('adminUsers.deactivate')}</button>}
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy && <Loader2 size={13} className="spin" />} {t('common.save')}
            </button>
          </>}
        >
          <div className="grid-2">
            <label>{t('adminUsers.username')}<input value={editing.username || ''} onChange={(e) => setEditing({ ...editing, username: e.target.value })} /></label>
            <label>{t('adminUsers.role')}
              <select value={editing.role || ''} onChange={(e) => setEditing({ ...editing, role: e.target.value })}>
                {roleOptions.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label>{editing.id ? t('adminUsers.password') : t('adminUsers.initialPassword')} {editing.id && <span className="muted">{t('adminUsers.passwordKeepHint')}</span>}
              <input type="password" value={editing.password || ''} autoComplete="new-password"
                onChange={(e) => setEditing({ ...editing, password: e.target.value })} />
            </label>
            <label>{t('adminUsers.grade')}<input value={editing.grade || ''} onChange={(e) => setEditing({ ...editing, grade: e.target.value })} placeholder="SDO / DGFS / …" /></label>
            {/* Line manager — used by approval rules with approver_type 'manager'
                ("route to the requester's manager"). Typeahead-backed so we
                never pull the whole directory into a <select>. */}
            <label>{t('adminUsers.lineManager')}
              <ManagerPicker
                initialLabel={editing.managerName ? `${editing.managerName}` : ''}
                placeholder={t('adminUsers.noManager')}
                onSelect={(id) => setEditing((e: any) => ({ ...e, managerId: id }))}
              />
            </label>
          </div>

          <label className="row" style={{ alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={!!editing.mustChangePassword}
              onChange={(e) => setEditing({ ...editing, mustChangePassword: e.target.checked })} />
            <span>{t('adminUsers.forceReset')}</span>
          </label>

          <div className="field">
            <label>{t('adminUsers.regionAccess')}</label>
            {editRegions.length === 0 && <p className="muted">{t('adminUsers.noRegions')}</p>}
            <div className="dep-grid">
              {editRegions.map((r) => (
                <label key={r} className="dep-chip">
                  <input type="checkbox" checked={(editing.regionAccess || []).includes(r)} onChange={() => toggleRegion(r)} />
                  {r}
                </label>
              ))}
            </div>
          </div>

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
