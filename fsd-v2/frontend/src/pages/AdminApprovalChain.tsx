import { useEffect, useMemo, useState } from 'react';
import { Plus, ArrowUp, ArrowDown, Trash2, Save, ChevronRight, GitBranch } from 'lucide-react';
import { api } from '../api/client';
import { Modal } from '../components/Modal';
import { TokenSelect, TokenOption } from '../components/TokenSelect';
import { useT } from '../hooks/useT';
import { useToast } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';

// Kept aligned with backend modules/approvals/grade.ts so admins can't
// pick a min_grade that silently fails server-side.
const GRADES = ['SO', 'SSO', 'ADO', 'DO', 'SDO', 'ADD', 'DDGFS', 'DGFS'];

// Built-in asset types ship in code (backend ResourceType comment: "Built-ins
// remain present in code as a floor"), so they may not appear in the
// resource-types table. We seed the scope dropdown with these and merge in the
// live catalog + any types actually in use, so custom types like "Hot Desk"
// are always selectable.
const BUILTIN_ASSET_TYPES = ['Meeting Room', 'Vehicle', 'Equipment', 'Top Management'];

type Scope = 'asset_type' | 'resource' | 'department' | 'tenant';
type ApproverType = 'user' | 'role' | 'manager' | 'department_head';
interface Level {
  name: string;
  approver_type?: ApproverType;
  approver_role?: string;
  min_grade?: string;
  approver_user_ids?: string[];
  auto_after_hours?: number;
  parallel?: boolean;
  require_all?: boolean;
  dependencies?: number[];
}

// Infer the editor's approver-type for a level saved before approver_type
// existed: a role-only legacy level shows as "by role", everything else as
// "specific users" — so old rules render with their real configuration.
function effectiveType(l: Level): ApproverType {
  if (l.approver_type) return l.approver_type;
  return l.approver_role && !(l.approver_user_ids?.length) ? 'role' : 'user';
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
  return { name, approver_type: 'user', approver_role: '', min_grade: '', approver_user_ids: [], auto_after_hours: 0, parallel: false, require_all: false, dependencies: [] };
}

// Visual diagram of the approval chain. Levels that share a dependency rank
// run in parallel (stacked vertically); sequential stages become columns
// separated by chevrons. Mirrors the runtime's "explicit deps, else previous
// level" rule so the picture matches what the server will actually do.
function ChainGraph({ levels, fallback }: { levels: Level[]; fallback: string }) {
  if (!levels.length) return null;
  const depsOf = (i: number) => (levels[i].dependencies?.length ? levels[i].dependencies! : (i === 0 ? [] : [i - 1]));
  const rank: number[] = [];
  for (let i = 0; i < levels.length; i++) {
    const d = depsOf(i);
    rank[i] = d.length ? Math.max(...d.map((x) => rank[x] ?? 0)) + 1 : 0;
  }
  const maxRank = rank.length ? Math.max(...rank) : 0;
  const cols: number[][] = Array.from({ length: maxRank + 1 }, () => []);
  rank.forEach((r, i) => cols[r].push(i));
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', overflowX: 'auto', padding: '8px 0' }}>
      {cols.map((col, c) => (
        <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {col.map((i) => (
              <div key={i} className="tag info" style={{ whiteSpace: 'nowrap' }}>
                <span className="num small">{i + 1}</span> {levels[i].name || fallback}
              </div>
            ))}
          </div>
          {c < cols.length - 1 && <ChevronRight size={16} className="muted" />}
        </div>
      ))}
    </div>
  );
}

export function AdminApprovalChain() {
  const { t } = useT();
  const toast = useToast();
  const [rules, setRules] = useState<any[]>([]);
  const [resources, setResources] = useState<any[]>([]);
  const [resourceTypes, setResourceTypes] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    const [r, res, rt, dept, usr] = await Promise.all([
      api.listApprovalRules(),
      api.resources().catch(() => []),
      api.resourceTypes().catch(() => []),
      api.departments().catch(() => []),
      api.users().catch(() => []),
    ]);
    setRules(r || []);
    setResources(res || []);
    setResourceTypes(rt || []);
    setDepartments(dept || []);
    setUsers(usr || []);
  }

  // Union of built-in types, the live resource-type catalog, the asset types
  // actually assigned to resources (these are the values the server matches
  // on), and the rule's current value — so editing never drops an existing
  // scope and new categories show up automatically.
  // Address-book options for the approver picker (TokenSelect): username as the
  // primary line, role/grade as the secondary so admins can disambiguate.
  const userOptions = useMemo<TokenOption[]>(() =>
    users.map((u) => ({
      value: u.id,
      label: u.username ?? u.id,
      sub: [u.role, u.grade].filter(Boolean).join(' · '),
    })), [users]);

  const assetTypeOptions = useMemo(() => {
    const set = new Set<string>(BUILTIN_ASSET_TYPES);
    resources.forEach((r) => { if (r.assetType) set.add(r.assetType); });
    resourceTypes.forEach((rt) => { const v = rt.label || rt.key; if (v) set.add(v); });
    if (editing?.scopeType === 'asset_type' && editing.scopeValue) set.add(editing.scopeValue);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [resources, resourceTypes, editing?.scopeType, editing?.scopeValue]);

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
  async function moveLevel(i: number, delta: number) {
    if (!editing) return;
    const j = i + delta;
    if (j < 0 || j >= editing.levels.length) return;
    const arr = [...editing.levels];
    [arr[i], arr[j]] = [arr[j], arr[i]];
    // Reordering can make a dependency point forwards (a step depending on a
    // later one). Those deps get dropped — warn first so an accidental
    // up/down click doesn't silently destroy a carefully wired fan-in.
    const wouldStrip = arr.some((l, idx) => (l.dependencies ?? []).some((d) => d >= idx));
    if (wouldStrip) {
      const ok = await confirmDialog({
        title: t('approvalChain.reorderStripWarn'),
        tone: 'danger',
        confirmText: t('approvalChain.reorderConfirm'),
        cancelText: t('common.cancel'),
      });
      if (!ok) return;
    }
    const levels = arr.map((l, idx) => ({ ...l, dependencies: (l.dependencies ?? []).filter((d) => d < idx) }));
    setEditing((e) => e ? { ...e, levels } : e);
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
    // Reject "ghost steps": a level with no resolvable approver would
    // materialise a step assigned to nobody, stranding the booking. Manager /
    // department-head levels resolve relative to the booking, so they're
    // always fine; static levels need a role, a grade, or specific people.
    for (const lvl of editing.levels) {
      const tp = effectiveType(lvl);
      if (tp === 'manager' || tp === 'department_head') continue;
      const hasApprover = !!(lvl.approver_role || lvl.min_grade || (lvl.approver_user_ids?.length));
      if (!hasApprover) {
        toast.error(
          t('approvalChain.validateTitle'),
          t('approvalChain.validateNoApprover', { name: lvl.name || t('approvalChain.ruleFallback') }),
        );
        return;
      }
    }
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
    const tp = effectiveType(l);
    if (tp === 'manager') parts.push(t('approvalChain.typeManager'));
    else if (tp === 'department_head') parts.push(t('approvalChain.typeDeptHead'));
    else {
      if (l.approver_role) parts.push(l.approver_role);
      if (l.approver_user_ids?.length) parts.push(t('approvalChain.specificCount', { n: l.approver_user_ids.length }));
    }
    if (l.min_grade) parts.push(`≥ ${l.min_grade}`);
    if (tp === 'user' && (l.approver_user_ids?.length ?? 0) > 1) {
      parts.push(l.require_all ? t('approvalChain.modeAllShort') : t('approvalChain.anyOf'));
    }
    if (l.auto_after_hours) parts.push(t('approvalChain.autoHours', { n: l.auto_after_hours }));
    return parts.length ? '· ' + parts.join(' · ') : '';
  }

  // Switching approver type clears the fields that no longer apply so a hidden
  // value can't silently ride along (e.g. a stale role under a 'manager' level).
  function setApproverType(i: number, type: ApproverType) {
    const patch: Partial<Level> = { approver_type: type };
    if (type === 'manager' || type === 'department_head') {
      patch.approver_role = ''; patch.approver_user_ids = []; patch.min_grade = '';
    } else if (type === 'role') {
      patch.approver_user_ids = [];
    } else { // 'user'
      patch.approver_role = '';
    }
    updateLevel(i, patch);
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
                  {assetTypeOptions.map((a) => <option key={a} value={a}>{a}</option>)}
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

          <h4 style={{ marginTop: 24, marginBottom: 4 }}><GitBranch size={14} style={{ verticalAlign: '-2px' }}/> {t('approvalChain.levels')}</h4>
          {editing.levels.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <small className="muted">{t('approvalChain.preview')}</small>
              <ChainGraph levels={editing.levels} fallback={t('approvalChain.ruleFallback')} />
            </div>
          )}
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
                {/* Who approves this level. 'manager'/'department_head' resolve
                    relative to each booking, so the static role/user pickers are
                    hidden for them. */}
                <label style={{ gridColumn: '1 / -1' }}>{t('approvalChain.approverType')}
                  <select value={effectiveType(lvl)} onChange={(e) => setApproverType(i, e.target.value as ApproverType)}>
                    <option value="user">{t('approvalChain.typeUser')}</option>
                    <option value="role">{t('approvalChain.typeRole')}</option>
                    <option value="manager">{t('approvalChain.typeManager')}</option>
                    <option value="department_head">{t('approvalChain.typeDeptHead')}</option>
                  </select>
                </label>

                {effectiveType(lvl) === 'role' && (
                  <label>{t('approvalChain.approverRole')}
                    <select value={lvl.approver_role ?? ''} onChange={(e) => updateLevel(i, { approver_role: e.target.value })}>
                      <option value="">—</option>
                      <option>System Admin</option><option>Security Admin</option><option>Room Admin</option><option>Secretary</option>
                    </select>
                  </label>
                )}
                {(effectiveType(lvl) === 'user' || effectiveType(lvl) === 'role') && (
                  <label>{t('approvalChain.minGrade')}
                    <select value={lvl.min_grade ?? ''} onChange={(e) => updateLevel(i, { min_grade: e.target.value })}>
                      <option value="">{t('approvalChain.anyGrade')}</option>
                      {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </label>
                )}
                {effectiveType(lvl) === 'user' && (
                  <label style={{ gridColumn: '1 / -1' }}>
                    {t('approvalChain.specificApproversCount', { n: (lvl.approver_user_ids ?? []).length })}
                    <TokenSelect
                      options={userOptions}
                      value={lvl.approver_user_ids ?? []}
                      onChange={(ids) => updateLevel(i, { approver_user_ids: ids })}
                      placeholder={t('approvalChain.userSearchPlaceholder')}
                      emptyText={t('approvalChain.userSearchEmpty')}
                    />
                  </label>
                )}
                {effectiveType(lvl) === 'user' && (lvl.approver_user_ids?.length ?? 0) > 1 && (
                  <label style={{ gridColumn: '1 / -1' }}>{t('approvalChain.approverMode')}
                    <select value={lvl.require_all ? 'all' : 'any'}
                            onChange={(e) => updateLevel(i, { require_all: e.target.value === 'all', parallel: e.target.value !== 'all' })}>
                      <option value="any">{t('approvalChain.modeAny')}</option>
                      <option value="all">{t('approvalChain.modeAll')}</option>
                    </select>
                  </label>
                )}
                {(effectiveType(lvl) === 'manager' || effectiveType(lvl) === 'department_head') && (
                  <p className="muted text-sm" style={{ gridColumn: '1 / -1', margin: 0 }}>
                    {effectiveType(lvl) === 'manager' ? t('approvalChain.typeManagerHint') : t('approvalChain.typeDeptHeadHint')}
                  </p>
                )}
                <label>{t('approvalChain.autoApproveAfter')}
                  <input type="number" min={0} value={lvl.auto_after_hours ?? 0}
                         onChange={(e) => updateLevel(i, { auto_after_hours: parseInt(e.target.value || '0', 10) })}/>
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
