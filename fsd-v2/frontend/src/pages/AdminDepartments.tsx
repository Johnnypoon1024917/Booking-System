import { useEffect, useMemo, useState } from 'react';
import { Plus, Building, ChevronRight, CornerDownRight, Save, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { Modal } from '../components/Modal';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

interface Dept {
  id: string;
  name: string;
  code?: string;
  parentId?: string | null;
}

interface TreeRow extends Dept {
  _depth: number;
  _childCount: number;
}

function initials(s: string) {
  return (s || '').split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();
}
function hueBackground(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `linear-gradient(135deg, hsl(${h % 360} 60% 45%), hsl(${(h + 30) % 360} 70% 55%))`;
}

// Port of v1's AdminDepartments.vue — full CRUD on the M2M-backed
// department tree. The flattening visitor is identical to v1's so the
// indentation lines up the same way.
export function AdminDepartments() {
  const { t } = useT();
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Dept[]>([]);
  const [editing, setEditing] = useState<Partial<Dept> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try { setItems(await api.departments() || []); }
    catch (e: any) { toast.error(t('adminDepartments.loadFailed'), e.displayMessage || e.message); }
    finally { setLoading(false); }
  }

  const tree = useMemo<TreeRow[]>(() => {
    const byParent: Record<string, Dept[]> = {};
    for (const d of items) {
      const p = d.parentId || '';
      (byParent[p] = byParent[p] || []).push(d);
    }
    const out: TreeRow[] = [];
    const seen = new Set<string>();
    function walk(parentId: string, depth: number) {
      const kids = (byParent[parentId] || []).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      for (const d of kids) {
        if (seen.has(d.id)) continue;
        seen.add(d.id);
        out.push({ ...d, _depth: depth, _childCount: (byParent[d.id] || []).length });
        walk(d.id, depth + 1);
      }
    }
    walk('', 0);
    for (const d of items) if (!seen.has(d.id)) out.push({ ...d, _depth: 0, _childCount: 0 });
    return out;
  }, [items]);

  async function save() {
    if (!editing?.name?.trim()) { toast.warning(t('adminDepartments.nameRequired')); return; }
    setBusy(true);
    try {
      const payload = { name: editing.name, code: editing.code, parentId: editing.parentId || undefined };
      if (editing.id) await api.updateDepartment(editing.id, payload);
      else            await api.createDepartment(payload);
      toast.success(t('common.saved'));
      setEditing(null);
      load();
    } catch (e: any) { toast.error(t('adminDepartments.saveFailed'), e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!editing?.id) return;
    if (!(await confirmDialog({ title: t('adminDepartments.deleteConfirm', { name: editing.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    setBusy(true);
    try {
      await api.deleteDepartment(editing.id);
      toast.success(t('adminDepartments.deleted'));
      setEditing(null);
      load();
    } catch (e: any) { toast.error(t('adminDepartments.deleteFailed'), e.displayMessage || e.message); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <header className="page-head">
        <div>
          <h1>{t('adminDepartments.title')}</h1>
          <p className="muted small">{t('adminDepartments.subtitle')}</p>
        </div>
        <button className="btn primary" onClick={() => setEditing({ name: '', code: '', parentId: '' })}>
          <Plus size={14} /> {t('adminDepartments.newDepartment')}
        </button>
      </header>

      {loading ? (
        <div>{[1, 2, 3, 4].map((n) => (
          <div key={n} className="card" style={{ padding: 12, marginBottom: 6 }}><Skeleton height="32px" /></div>
        ))}</div>
      ) : !items.length ? (
        <EmptyState icon={Building} title={t('adminDepartments.emptyTitle')}
                    description={t('adminDepartments.emptyDescription')} />
      ) : (
        <div>
          {tree.map((row) => (
            <div key={row.id} className="dept-row card" style={{ marginLeft: row._depth * 28 }}
                 onClick={() => setEditing({ ...row })}>
              {row._depth > 0 && <CornerDownRight size={14} className="muted" />}
              <div className="dept-badge" style={{ background: hueBackground(row.name) }}>
                {initials(row.name)}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 500 }}>{row.name}</div>
                <small className="muted">
                  {row.code || '—'}{row._childCount > 0 ? ` · ${t('adminDepartments.subUnitCount', { count: row._childCount })}` : ''}
                </small>
              </div>
              <ChevronRight size={16} className="muted" />
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal
          title={editing.id ? t('adminDepartments.editDepartment', { name: editing.name }) : t('adminDepartments.createDepartment')}
          onClose={() => setEditing(null)}
          footer={<>
            {editing.id && <button className="btn danger" disabled={busy} onClick={remove}>
              <Trash2 size={13} /> {t('common.delete')}
            </button>}
            <span className="spacer" />
            <button className="btn ghost" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            <button className="btn primary" disabled={busy} onClick={save}>
              <Save size={13} /> {t('common.save')}
            </button>
          </>}
        >
          <label>{t('adminDepartments.name')}
            <input value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </label>
          <label>{t('adminDepartments.code')}
            <input value={editing.code || ''} onChange={(e) => setEditing({ ...editing, code: e.target.value })}
                   placeholder="OPS / TRN / ADM" />
          </label>
          <label>{t('adminDepartments.parent')}
            <select value={editing.parentId || ''} onChange={(e) => setEditing({ ...editing, parentId: e.target.value || null })}>
              <option value="">{t('adminDepartments.topLevel')}</option>
              {items.filter((d) => d.id !== editing.id).map((d) =>
                <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </label>
        </Modal>
      )}
    </div>
  );
}
