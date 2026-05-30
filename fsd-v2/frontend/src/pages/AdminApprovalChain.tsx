import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowUp, ArrowDown, Trash2, Save, ChevronRight, GitBranch } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { useT } from '../hooks/useT';
import { useToast } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';

// Kept aligned with backend modules/approvals/grade.ts so admins can't
// pick a min_grade that silently fails server-side.
const GRADES = ['SO', 'SSO', 'ADO', 'DO', 'SDO', 'ADD', 'DDGFS', 'DGFS'];

type Scope = 'asset_type' | 'resource' | 'department' | 'tenant';
interface Level {
  name: string;
  approver_role?: string;
  min_grade?: string;
  approver_user_ids?: string[];
  auto_after_hours?: number;
  parallel?: boolean;
  dependencies?: number[];
}
interface Rule {
  id?: string;
  name: string;
  scopeType: Scope;
  scopeValue: string;
  priority: number;
  isActive: boolean;
  levels: Level[];
}

function emptyLevel(name: string): Level {
  return { name, approver_role: '', min_grade: '', approver_user_ids: [], auto_after_hours: 0, parallel: false, dependencies: [] };
}

export function AdminApprovalChain() {
  const { t } = useT();
  const toast = useToast();
  const [rules, setRules] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    const [r, res, dept, usr] = await Promise.all([
      api.listApprovalRules(),
      api.resources().catch(() => []),
      api.departments().catch(() => []),
      api.users().catch(() => []),
    ]);
    setRules(r || []);
    setResources(res || []);
    setDepartments(dept || []);
    setUsers(usr || []);
  }

  function openNew() {
    setEditing({
      name: '', scopeType: 'asset_type', scopeValue: 'Meeting Room',
      priority: 100, isActive: true, levels: [emptyLevel(t('approvalChain.defaultLevelName'))],
    });
  }
  function openExisting(r: any) {
    // Deep clone + normalise so missing arrays on legacy rules don't
    // break the editor's state assumptions.
    const clone: Rule = JSON.parse(JSON.stringify({
      id: r.id, name: r.name, scopeType: r.scopeType, scopeValue: r.scopeValue ?? '',
      priority: r.priority ?? 100, isActive: r.isActive ?? true,
      levels: (r.levels ?? []).map((l: any) => ({
        ...l, approver_user_ids: l.approver_user_ids ?? [], dependencies: l.dependencies ?? [],
      })),
    }));
    setEditing(clone);
  }

  function setEd<K extends keyof Rule>(k: K, v: Rule[K]) {
    setEditing((e) => e ? { ...e, [k]: v } : e);
  }
  function updateLevel(i: number, patch: Partial<Level>) {
    setEditing((e) => {
      if (!e) return e;
      const levels = e.levels.map((l, idx) => idx === i ? { ...l, ...patch } : l);
      return { ...e, levels };
    });
  }
  function addLevel() {
    setEditing((e) => e ? { ...e, levels: [...e.levels, emptyLevel(t('approvalChain.stepN', { n: e.levels.length + 1 }))] } : e);
  }
  function removeLevel(i: number) {
    setEditing((e) => {
      if (!e) return e;
      const levels = e.levels.filter((_, idx) => idx !== i).map((l) => ({
        // Renumbering invalidates dependency indices: drop the removed
        // index, shift higher indices down by one.
        ...l, dependencies: (l.dependencies ?? []).filter((d) => d !== i).map((d) => d > i ? d - 1 : d),
      }));
      return { ...e, levels };
    });
  }
  function moveLevel(i: number, delta: number) {
    setEditing((e) => {
      if (!e) return e;
      const j = i + delta;
      if (j < 0 || j >= e.levels.length) return e;
      const arr = [...e.levels];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      // Reordering makes deps ambiguous — drop deps that no longer point
      // strictly backwards.
      return { ...e, levels: arr.map((l, idx) => ({ ...l, dependencies: (l.dependencies ?? []).filter((d) => d < idx) })) };
    });
  }
  function toggleDep(i: number, depIdx: number, checked: boolean) {
    setEditing((e) => {
      if (!e) return e;
      const deps = new Set(e.levels[i].dependencies ?? []);
      if (checked) deps.add(depIdx); else deps.delete(depIdx);
      const levels = e.levels.map((l, idx) => idx === i
        ? { ...l, dependencies: [...deps].sort((a, b) => a - b) }
        : l);
      return { ...e, levels };
    });
  }

  async function save() {
    if (!editing || !editing.name.trim()) return;
    setBusy(true);
    try {
      if (editing.id) await api.updateApprovalRule(editing.id, editing);
      else await api.createApprovalRule(editing);
      setEditing(null);
      await load();
    } catch (e: any) { toast.error(t('common.error'), e.displayMessage); }
    finally { setBusy(false); }
  }
  async function del() {
    if (!editing?.id) return;
    const ok = await confirmDialog({
      title: t('approvalChain.confirmDeleteRule'),
      tone: 'danger',
      confirmText: t('common.delete'),
      cancelText: t('common.cancel'),
    });
    if (!ok) return;
    setBusy(true);
    try { await api.deleteApprovalRule(editing.id); setEditing(null); await load(); }
    catch (e: any) { toast.error(t('common.error'), e.displayMessage); }
    finally { setBusy(false); }
  }

  function describeLevel(l: Level): string {
    const parts: string[] = [];
    if (l.approver_role) parts.push(l.approver_role);
    if (l.min_grade) parts.push(`≥ ${l.min_grade}`);
    if (l.approver_user_ids?.length) parts.push(t('approvalChain.specificCount', { n: l.approver_user_ids.length }));
    if (l.parallel) parts.push(t('approvalChain.anyOf'));
    if (l.auto_after_hours) parts.push(t('approvalChain.autoHours', { n: l.auto_after_hours }));
    return parts.length ? '· ' + parts.join(' · ') : '';
  }
  function scopeLabel(r: any): string {
    if (r.scopeType === 'resource') return resources.find((x) => x.id === r.scopeValue)?.name || r.scopeValue;
    if (r.scopeType === 'department') return departments.find((x) => x.id === r.scopeValue)?.name || r.scopeValue;
    return r.scopeValue;
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('approvalChain.title')}</h1>
          <p className="muted">{t('approvalChain.routingSubtitle')}</p>
        </div>
        <button className="btn primary" onClick={openNew}><Plus size={14}/> {t('approvalChain.newRule')}</button>
      </header>

      {rules.length === 0 && <p className="muted">{t('approvalChain.routingEmpty')}</p>}

      {rules.map((r) => (
        <article key={r.id} className="card rule-card" onClick={() => openExisting(r)} style={{ cursor: 'pointer' }}>
          <div className="prio">{r.priority}</div>
          <div style={{ minWidth: 0 }}>
            <div className="row gap-sm" style={{ alignItems: 'baseline' }}>
              <h3 className="truncate">{r.name}</h3>
              <span className="tag info">{r.scopeType}{r.scopeValue ? `: ${scopeLabel(r)}` : ''}</span>
              {!r.isActive && <span className="tag warning">{t('common.inactive')}</span>}
            </div>
            <div className="muted text-sm row gap-sm" style={{ flexWrap: 'wrap' }}>
              {(r.levels ?? []).map((l: Level, i: number) => (
                <span key={i} className="level-pill">
                  <span className="num">{i + 1}</span> {l.name} <small>{describeLevel(l)}</small>
                </span>
              ))}
            </div>
          </div>
          <ChevronRight size={16} className="muted"/>
        </article>
      ))}

      {editing && (
        <Modal title={editing.id ? t('approvalChain.editRuleNamed', { name: editing.name || t('approvalChain.ruleFallback') }) : t('approvalChain.newRuleTitle')} onClose={() => setEditing(null)} footer={<>
          {editing.id && <button className="btn danger" disabled={busy} onClick={del}><Trash2 size={13}/> {t('common.delete')}</button>}
          <span className="spacer" />
          <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
          <button className="btn primary" disabled={busy || !editing.name.trim()} onClick={save}><Save size={13}/> {t('common.save')}</button>
        </>}>
          <div className="grid-2">
            <label>{t('approvalChain.name')}<input value={editing.name} onChange={(e) => setEd('name', e.target.value)}/></label>
            <label>{t('approvalChain.priority')}
              <input type="number" min={1} max={999} value={editing.priority}
                     onChange={(e) => setEd('priority', parseInt(e.target.value || '100', 10))}/>
            </label>
            <label>{t('approvalChain.scopeType')}
              <select value={editing.scopeType} onChange={(e) => { setEd('scopeType', e.target.value as Scope); setEd('scopeValue', ''); }}>
                <option value="asset_type">{t('approvalChain.scope.assetType')}</option>
                <option value="resource">{t('approvalChain.scope.resource')}</option>
                <option value="department">{t('approvalChain.scope.department')}</option>
                <option value="tenant">{t('approvalChain.scope.tenant')}</option>
              </select>
            </label>
            <label>{t('approvalChain.scopeValue')}
              {editing.scopeType === 'asset_type' && (
                <select value={editing.scopeValue} onChange={(e) => setEd('scopeValue', e.target.value)}>
                  <option value="">—</option>
                  <option>Meeting Room</option><option>Vehicle</option><option>Equipment</option><option>Top Management</option>
                </select>
              )}
              {editing.scopeType === 'resource' && (
                <select value={editing.scopeValue} onChange={(e) => setEd('scopeValue', e.target.value)}>
                  <option value="">—</option>
                  {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              )}
              {editing.scopeType === 'department' && (
                <select value={editing.scopeValue} onChange={(e) => setEd('scopeValue', e.target.value)}>
                  <option value="">—</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}
              {editing.scopeType === 'tenant' && (
                <input value="" disabled placeholder={t('approvalChain.tenantPlaceholder')}/>
              )}
            </label>
          </div>

          <label className="row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={editing.isActive} onChange={(e) => setEd('isActive', e.target.checked)}/>
            <span>{t('common.active')}</span>
          </label>

          <h4 style={{ marginTop: 24, marginBottom: 8 }}>{t('approvalChain.levels')}</h4>
          {editing.levels.map((lvl, i) => (
            <div key={i} className="card level-card">
              <div className="row gap-sm">
                <span className="num">{i + 1}</span>
                <input value={lvl.name} placeholder={t('approvalChain.levelNamePh')} style={{ flex: 1 }}
                       onChange={(e) => updateLevel(i, { name: e.target.value })}/>
                <button className="btn ghost" disabled={i === 0} onClick={() => moveLevel(i, -1)}><ArrowUp size={13}/></button>
                <button className="btn ghost" disabled={i === editing.levels.length - 1} onClick={() => moveLevel(i, 1)}><ArrowDown size={13}/></button>
                <button className="btn ghost danger" onClick={() => removeLevel(i)}><Trash2 size={13}/></button>
              </div>
              <div className="grid-2" style={{ marginTop: 8 }}>
                <label>{t('approvalChain.approverRole')}
                  <select value={lvl.approver_role ?? ''} onChange={(e) => updateLevel(i, { approver_role: e.target.value })}>
                    <option value="">—</option>
                    <option>System Admin</option><option>Security Admin</option><option>Room Admin</option><option>Secretary</option>
                  </select>
                </label>
                <label>{t('approvalChain.minGrade')}
                  <select value={lvl.min_grade ?? ''} onChange={(e) => updateLevel(i, { min_grade: e.target.value })}>
                    <option value="">{t('approvalChain.anyGrade')}</option>
                    {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
                <label style={{ gridColumn: '1 / -1' }}>
                  {t('approvalChain.specificApproversCount', { n: (lvl.approver_user_ids ?? []).length })}
                  <select multiple style={{ minHeight: 92 }}
                          value={lvl.approver_user_ids ?? []}
                          onChange={(e) => updateLevel(i, {
                            approver_user_ids: Array.from(e.target.selectedOptions).map((o) => o.value),
                          })}>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.username} · {u.role}{u.grade ? ` · ${u.grade}` : ''}</option>
                    ))}
                  </select>
                </label>
                <label>{t('approvalChain.autoApproveAfter')}
                  <input type="number" min={0} value={lvl.auto_after_hours ?? 0}
                         onChange={(e) => updateLevel(i, { auto_after_hours: parseInt(e.target.value || '0', 10) })}/>
                </label>
                <label className="row" style={{ alignSelf: 'end' }}>
                  <input type="checkbox" checked={!!lvl.parallel} onChange={(e) => updateLevel(i, { parallel: e.target.checked })}/>
                  <span>{t('approvalChain.parallelApprovers')}</span>
                </label>
              </div>

              {i > 0 && (
                <div style={{ marginTop: 8 }}>
                  <small className="muted">{t('approvalChain.dependenciesInline')}</small>
                  <div className="row gap-sm" style={{ flexWrap: 'wrap', marginTop: 4 }}>
                    {Array.from({ length: i }, (_, j) => {
                      const checked = (lvl.dependencies ?? []).includes(j);
                      return (
                        <label key={j} className={`dep-chip ${checked ? 'active' : ''}`}>
                          <input type="checkbox" checked={checked}
                                 onChange={(e) => toggleDep(i, j, e.target.checked)}
                                 style={{ display: 'none' }}/>
                          <span className="num small">{j + 1}</span>
                          <span>{editing.levels[j].name || t('approvalChain.stepN', { n: j + 1 })}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          ))}
          <button className="btn ghost" onClick={addLevel}><Plus size={13}/> {t('approvalChain.addLevel')}</button>
        </Modal>
      )}
    </div>
  );
}
