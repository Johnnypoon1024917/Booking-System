import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api } from '../api/client';
import { ResourceEditor } from '../components/ResourceEditor';
import { useToast } from '../stores/toast';
import { useT } from '../hooks/useT';
import { confirmDialog } from '../stores/confirm';

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

  useEffect(() => {
    load();
    api.departments().then(setDepartments).catch(() => setDepartments([]));
  }, []);
  function load() { api.adminResources().then(setItems); }

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
      <table className="data">
        <thead><tr>
          <th>{t('adminResources.name')}</th><th>{t('adminResources.location')}</th><th>{t('adminResources.region')}</th><th>{t('adminResources.type')}</th><th>{t('adminResources.capacityShort')}</th><th>{t('common.status')}</th><th></th>
        </tr></thead>
        <tbody>
          {items.map((r) => (
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
        </tbody>
      </table>

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
