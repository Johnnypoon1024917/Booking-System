import { useEffect, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { api } from '../api/client';
import { ResourceEditor } from '../components/ResourceEditor';
import { useToast } from '../stores/toast';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

const PAGE_SIZE = 50;

const blank = {
  name: '', location: '', region: '', assetType: 'Meeting Room',
  capacity: 4, isActive: true, isRestricted: false, requiresApproval: false,
  bookingMode: 'exclusive' as const, sharedCapacity: 1,
};

export function AdminResources() {
  const { t } = useT();
  const toast = useToast();
  const [items, setItems] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  useEffect(() => {
    load();
    api.departments().then(setDepartments).catch(() => setDepartments([]));
  }, []);
  function load() { api.adminResources().then(setItems); }

  // Enterprise tenants run hundreds of resources, so filter locally by name /
  // location / region and page the result instead of dumping every row.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((r) =>
      [r.name, r.location, r.region, r.assetType].some((f) => String(f || '').toLowerCase().includes(q)));
  }, [items, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  // Searching/filtering can shrink the list under the current page — snap back.
  useEffect(() => { if (page > pageCount - 1) setPage(0); }, [pageCount, page]);

  async function remove(r: any) {
    if (!(await confirmDialog({ title: t('adminResources.deleteConfirm', { name: r.name }), tone: 'danger', confirmText: t('common.delete'), cancelText: t('common.cancel') }))) return;
    try { await api.deleteResource(r.id); load(); }
    catch (e: any) { toast.error(t('adminResources.deleteFailed'), e.displayMessage || e.message); }
  }

  return (
    <div>
      <header className="page-head">
        <h1>{t('adminResources.title')}</h1>
        <button className="btn primary" onClick={() => setEditing({ ...blank })}>
          <Plus size={14} /> {t('adminResources.addRoom')}
        </button>
      </header>

      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
        <div className="row" style={{ position: 'relative', flex: '0 0 320px', maxWidth: '100%' }}>
          <Search size={15} style={{ position: 'absolute', left: 10, color: 'var(--text-muted)' }} />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }}
            placeholder={t('adminResources.searchPlaceholder')} style={{ paddingLeft: 30, width: '100%' }} />
        </div>
        <span className="muted small">{t('adminResources.countLabel', { shown: pageItems.length, total: filtered.length })}</span>
      </div>

      <table className="data">
        <thead><tr>
          <th>{t('adminResources.name')}</th><th>{t('adminResources.location')}</th><th>{t('adminResources.region')}</th><th>{t('adminResources.type')}</th><th>{t('adminResources.capacityShort')}</th><th>{t('common.status')}</th><th></th>
        </tr></thead>
        <tbody>
          {pageItems.map((r) => (
            <tr key={r.id}>
              <td>{r.name}</td>
              <td>{r.location || '—'}</td>
              <td>{r.region || '—'}</td>
              <td>{r.assetType}</td>
              <td>{r.capacity}</td>
              <td><span className={`tag ${r.isActive ? 'ok' : 'bad'}`}>{r.isActive ? t('common.active') : t('common.inactive')}</span></td>
              <td>
                <button className="btn ghost" onClick={() => setEditing({ ...r })}>{t('adminResources.edit')}</button>
                <button className="btn danger" onClick={() => remove(r)}>{t('common.delete')}</button>
              </td>
            </tr>
          ))}
          {pageItems.length === 0 && (
            <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>
              {query ? t('adminResources.noMatches') : t('adminResources.empty')}
            </td></tr>
          )}
        </tbody>
      </table>

      {pageCount > 1 && (
        <div className="row" style={{ justifyContent: 'center', gap: 12, marginTop: 12 }}>
          <button className="btn ghost" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>{t('common.prev')}</button>
          <span className="muted small">{t('adminResources.pageLabel', { page: safePage + 1, pages: pageCount })}</span>
          <button className="btn ghost" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>{t('common.next')}</button>
        </div>
      )}

      {editing && (
        <ResourceEditor
          resource={editing}
          departments={departments}
          onClose={() => setEditing(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}
