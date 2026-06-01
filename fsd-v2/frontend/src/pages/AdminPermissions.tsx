import { useEffect, useMemo, useState } from 'react';
import { RefreshCcw, Save, Lock, Plus, Trash2, Loader2 } from 'lucide-react';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { alertDialog, confirmDialog, promptDialog } from '../stores/confirm';

// Friendly labels for the built-in keys — kept in sync with backend
// modules/permissions/permission-catalog.ts.
const LABELS: Record<string, string> = {
  'booking.create': 'Create new bookings',
  'booking.cancel': 'Cancel own bookings',
  'booking.cancel_others': "Cancel anyone's bookings",
  'booking.update': 'Edit own bookings',
  'booking.read_all': 'See bookings across the tenant',
  'resource.create': 'Add new resources',
  'resource.update': 'Edit resource configuration',
  'resource.delete': 'Deactivate resources',
  'resource.split': 'Split a resource into sub-resources',
  'service.manage': 'Manage catering & services catalog',
  'user.create': 'Add users',
  'user.update': 'Edit user attributes',
  'user.deactivate': 'Deactivate users',
  'department.manage': 'Manage departments',
  'holiday.manage': 'Add / edit holidays',
  'holiday.import': 'Bulk-import holidays from ICS',
  'broadcast.manage': 'Publish broadcast banners',
  'approval.decide': 'Approve / reject bookings',
  'approval.delegate': 'Re-route approvals to another approver',
  'approval.bypass': 'Bypass the approval chain',
  'approval_rule.manage': 'Edit approval rule policies',
  'webhook.manage': 'Manage webhook subscriptions',
  'integration.manage': 'Configure M365 / Google / Zoom',
  'permission.manage': 'Edit this matrix',
  'report.view': 'View reports',
  'report.export': 'Export to CSV / XLSX',
  'audit.view': 'View audit trail',
  'customization.manage': 'Edit tenant customization',
  'tenant.manage': 'Manage tenant lifecycle',
};

// The absolute root role. PermissionsGuard hard-bypasses it server-side, so
// its matrix row has no effect — editing it is both meaningless and a footgun
// (an admin who unticks "Edit this matrix" believes they locked themselves
// out). We render it read-only; the backend also rejects writes to it.
const ROOT_ROLE = 'System Admin';

// Built-in roles every tenant ships with — re-permissionable but not deletable
// (the backend enforces the same set via permission-catalog.systemRoles()).
// Any role outside this set is a tenant-defined custom role and shows a delete
// control in its matrix column header.
const SYSTEM_ROLES = new Set([
  'System Admin', 'Security Admin', 'Room Admin', 'Secretary', 'General User',
]);

export function AdminPermissions() {
  const { t } = useT();
  const [catalog, setCatalog] = useState<{ title: string; keys: string[] }[]>([]);
  const [matrix, setMatrix] = useState<Record<string, Set<string>>>({});
  const [original, setOriginal] = useState<Record<string, string[]>>({});
  // Per-role optimistic-concurrency tokens from the last load/save. Echoed
  // back on save so a concurrent edit is rejected instead of overwritten.
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await api.getPermissions();
      setCatalog(data.catalog ?? []);
      const m: Record<string, Set<string>> = {};
      const o: Record<string, string[]> = {};
      for (const role of Object.keys(data.roles ?? {})) {
        m[role] = new Set(data.roles[role] ?? []);
        o[role] = (data.roles[role] ?? []).slice();
      }
      setMatrix(m);
      setOriginal(o);
      setVersions(data.versions ?? {});
    } finally { setLoading(false); }
  }

  const roles = useMemo(() => Object.keys(matrix).sort(), [matrix]);

  const dirty = useMemo(() => {
    for (const r of Object.keys(matrix)) {
      const a = [...matrix[r]].sort().join(',');
      const b = (original[r] ?? []).slice().sort().join(',');
      if (a !== b) return true;
    }
    return false;
  }, [matrix, original]);

  function toggle(role: string, key: string) {
    if (role === ROOT_ROLE) return; // root role is immutable
    setMatrix((prev) => {
      const s = new Set(prev[role] ?? []);
      s.has(key) ? s.delete(key) : s.add(key);
      return { ...prev, [role]: s };
    });
  }
  function has(role: string, key: string): boolean {
    return matrix[role]?.has(key) ?? false;
  }

  async function saveAll() {
    setBusy(true);
    try {
      // Only PUT roles whose permission set actually changed — saves a
      // round-trip per untouched role and keeps the audit log focused.
      // The root role is never sent (its row is immutable server-side).
      for (const r of Object.keys(matrix)) {
        if (r === ROOT_ROLE) continue;
        const next = [...matrix[r]].sort();
        const prev = (original[r] ?? []).slice().sort();
        if (next.join(',') !== prev.join(',')) {
          // Pass the role's known version for optimistic concurrency — the
          // backend returns the new version, which we store for the next save.
          const res = await api.setRolePermissions(r, [...matrix[r]], versions[r]);
          setOriginal((o) => ({ ...o, [r]: [...matrix[r]] }));
          if (res?.version) setVersions((v) => ({ ...v, [r]: res.version }));
        }
      }
    } catch (e: any) {
      // 409 = someone else edited a role since we loaded. Reload so the
      // admin re-applies against fresh data instead of clobbering it.
      if (e?.response?.status === 409) {
        await alertDialog({ title: t('permissions.conflictTitle'), message: e.displayMessage || t('permissions.conflictBody'), tone: 'danger' });
        await load();
      } else {
        await alertDialog({ title: t('common.error'), message: e.displayMessage, tone: 'danger' });
      }
    }
    finally { setBusy(false); }
  }

  // Add a tenant-defined custom role (e.g. "Catering Staff"). It lands in the
  // matrix with no permissions ticked; the admin then grants what it needs and
  // saves. Names are validated/deduped server-side.
  async function addRole() {
    const name = await promptDialog({
      title: t('permissions.addRoleTitle', { defaultValue: 'Add custom role' }),
      message: t('permissions.addRoleHint', { defaultValue: 'Create a new role, then tick the permissions it should have and Save.' }),
      inputLabel: t('permissions.roleName', { defaultValue: 'Role name' }),
      placeholder: 'e.g. Catering Staff',
      required: true,
      confirmText: t('common.add', { defaultValue: 'Add' }),
      cancelText: t('common.cancel'),
    });
    if (!name || !name.trim()) return;
    setBusy(true);
    try {
      await api.createRole(name.trim());
      await load();
    } catch (e: any) {
      await alertDialog({ title: t('common.error'), message: e.displayMessage || e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  // Delete a custom role. Built-in / in-use roles are rejected server-side and
  // surfaced as an alert (e.g. "3 users still have this role").
  async function removeRole(role: string) {
    if (!(await confirmDialog({
      title: t('permissions.deleteRoleConfirm', { role, defaultValue: `Delete the "${role}" role?` }),
      tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel'),
    }))) return;
    setBusy(true);
    try {
      await api.deleteRole(role);
      await load();
    } catch (e: any) {
      await alertDialog({ title: t('common.error'), message: e.displayMessage || e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('permissions.title')}</h1>
          <p className="muted">{t('permissions.matrixSubtitle')}</p>
        </div>
        <div className="row gap-sm">
          <button className="btn ghost" onClick={load} disabled={loading}><RefreshCcw size={14}/> {t('common.refresh')}</button>
          <button className="btn ghost" onClick={addRole} disabled={busy || loading}>
            <Plus size={14}/> {t('permissions.addRole', { defaultValue: 'Add custom role' })}
          </button>
          <button className="btn primary" onClick={saveAll} disabled={busy || !dirty}>
            {busy ? <Loader2 size={14} className="spin"/> : <Save size={14}/>} {t('common.save')}
          </button>
        </div>
      </header>

      {loading && <p className="muted">{t('common.loading')}</p>}

      {!loading && (
        <>
          <div className="banner info">
            <Lock size={16}/>
            <span>{t('permissions.matrixHelp')}</span>
          </div>

          <div className="card" style={{ padding: 0, overflowX: 'auto' }}>
            <table className="data matrix">
              <thead>
                <tr>
                  <th className="left">{t('permissions.permission')}</th>
                  {roles.map((r) => (
                    <th key={r} className="role">
                      {r}
                      {r === ROOT_ROLE && <Lock size={11} style={{ marginLeft: 4, verticalAlign: 'middle' }} aria-label={t('permissions.rootLocked')} />}
                      {!SYSTEM_ROLES.has(r) && (
                        <button
                          type="button"
                          className="btn ghost xs"
                          style={{ marginLeft: 4, padding: '0 4px', verticalAlign: 'middle' }}
                          onClick={() => removeRole(r)}
                          disabled={busy}
                          title={t('permissions.deleteRole', { role: r, defaultValue: `Delete the "${r}" role` })}
                          aria-label={t('permissions.deleteRole', { role: r, defaultValue: `Delete the "${r}" role` })}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {catalog.map((g) => (
                  <span key={g.title} style={{ display: 'contents' }}>
                    <tr className="group-row">
                      <th colSpan={roles.length + 1}>{g.title}</th>
                    </tr>
                    {g.keys.map((k) => (
                      <tr key={k}>
                        <th className="left">
                          <code>{k}</code>
                          <small className="muted block">{t(`permissions.labels.${k.replace(/\./g, '_')}`, { defaultValue: LABELS[k] ?? '' })}</small>
                        </th>
                        {roles.map((r) => (
                          <td key={r} className="check" style={{ textAlign: 'center' }}>
                            <input type="checkbox" checked={has(r, k)} onChange={() => toggle(r, k)}
                                   disabled={r === ROOT_ROLE}
                                   title={r === ROOT_ROLE ? t('permissions.rootLocked') : undefined}
                                   aria-label={`${r}: ${t(`permissions.labels.${k.replace(/\./g, '_')}`, { defaultValue: LABELS[k] || k })}`}/>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </span>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
