import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, X, Combine } from 'lucide-react';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { confirmDialog } from '../stores/confirm';

interface Resource {
  id?: string;
  name?: string;
  location?: string;
  region?: string;
  assetType?: string;
  capacity?: number;
  isActive?: boolean;
  isRestricted?: boolean;
  requiresApproval?: boolean;
  bookingMode?: 'exclusive' | 'shared';
  sharedCapacity?: number;
  departmentId?: string | null;
  equipment?: string[];
  compositeMode?: 'parent' | 'child' | '';
  subResources?: SubResource[];
  customFields?: CustomField[];
  operatingHours?: { open: string; close: string } | null;
}

interface SubResource { id?: string; name: string; capacity: number; }
interface CustomField { key: string; label: string; type: 'text' | 'number' | 'select' | 'date' | 'checkbox'; required?: boolean; options?: string[]; }

interface Props {
  resource: Resource;
  departments?: { id: string; name: string }[];
  onClose: () => void;
  onSaved?: () => void;
}

// Full resource edit dialog — replaces the 6-field inline form that
// used to live inside pages/AdminResources.tsx. Covers the basic info,
// the booking-mode (exclusive / shared / pods) selector, sub-resource
// hierarchy and a custom-fields editor so admins can tailor the booking
// flow per room. Port of v1's ResourceEditor.vue, simplified to drop
// the floor-plan position editor (still owned by the floor-plan view).
const REGIONS = ['Hong Kong', 'Kowloon', 'New Territories'];
const ASSET_TYPES = ['Meeting Room', 'Conference', 'Top Management', 'Equipment', 'Vehicle'];
const FIELD_TYPES: CustomField['type'][] = ['text', 'number', 'select', 'date', 'checkbox'];

export function ResourceEditor({ resource, departments = [], onClose, onSaved }: Props) {
  const toast = useToast();
  const [form, setForm] = useState<Resource>(() => ({
    bookingMode: 'exclusive',
    sharedCapacity: 1,
    isActive: true,
    subResources: [],
    customFields: [],
    equipment: [],
    ...resource,
  }));
  const [busy, setBusy] = useState(false);

  // Sub-resource hierarchy mode: whole (standalone), splittable (parent
  // with N child rooms), or pods (one resource bookable by N people).
  type Mode = 'whole' | 'splittable' | 'pods';
  const initialMode: Mode =
    form.bookingMode === 'shared' ? 'pods'
    : (form.compositeMode === 'parent' || (form.subResources?.length ?? 0) > 0) ? 'splittable'
    : 'whole';
  const [mode, setMode] = useState<Mode>(initialMode);

  // Operating-hours toggle: on when the resource already has a window.
  const [hoursEnabled, setHoursEnabled] = useState<boolean>(!!resource.operatingHours);

  // Re-hydrate child sub-resources when editing an existing splittable parent —
  // they live as separate child rows on the server, not nested on the parent.
  useEffect(() => {
    if (resource.id && initialMode === 'splittable' && !(resource.subResources?.length)) {
      api.resourceChildren(resource.id)
        .then((kids: any[]) => patch({
          subResources: (kids || []).map((k) => ({ id: k.id, name: k.name, capacity: k.capacity })),
        }))
        .catch(() => { /* non-fatal — admin can re-add */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mode === 'pods') {
      patch({ bookingMode: 'shared', sharedCapacity: form.sharedCapacity || form.capacity || 2 });
    } else {
      patch({ bookingMode: 'exclusive' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function patch(p: Partial<Resource>) { setForm((f) => ({ ...f, ...p })); }

  function addSub() {
    const next: SubResource = {
      name: `${form.name || 'Sub-resource'} ${((form.subResources?.length ?? 0) + 1)}`,
      capacity: form.capacity || 4,
    };
    patch({ subResources: [...(form.subResources || []), next] });
  }
  function removeSub(i: number) {
    patch({ subResources: (form.subResources || []).filter((_, idx) => idx !== i) });
  }
  function updateSub(i: number, p: Partial<SubResource>) {
    patch({ subResources: (form.subResources || []).map((s, idx) => idx === i ? { ...s, ...p } : s) });
  }

  function addField() {
    const next: CustomField = { key: `field_${(form.customFields?.length ?? 0) + 1}`, label: '', type: 'text' };
    patch({ customFields: [...(form.customFields || []), next] });
  }
  function removeField(i: number) {
    patch({ customFields: (form.customFields || []).filter((_, idx) => idx !== i) });
  }
  function updateField(i: number, p: Partial<CustomField>) {
    patch({ customFields: (form.customFields || []).map((f, idx) => idx === i ? { ...f, ...p } : f) });
  }

  const equipmentStr = useMemo(() => (form.equipment || []).join(', '), [form.equipment]);

  async function save() {
    if (!form.name?.trim()) { toast.warning('Name is required'); return; }
    // Operating hours are optional; when enabled, validate open < close so the
    // server doesn't silently ignore a backwards window.
    if (hoursEnabled && form.operatingHours) {
      const { open, close } = form.operatingHours;
      if (!open || !close) { toast.warning('Set both open and close times'); return; }
      if (close <= open) { toast.warning('Close time must be after open time'); return; }
    }
    // Build the payload explicitly so we control exactly what is sent: blank
    // location falls back to region (keeps the server equality filter happy),
    // and operatingHours is null unless the toggle is on.
    const payload: Resource = {
      ...form,
      location: form.location?.trim() || form.region || '',
      operatingHours: hoursEnabled ? form.operatingHours : null,
    };
    setBusy(true);
    try {
      if (form.id) await api.updateResource(form.id, payload);
      else         await api.createResource(payload);
      toast.success('Resource saved');
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error('Save failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  async function deactivate() {
    if (!form.id) return;
    if (!(await confirmDialog({ title: `Deactivate ${form.name}?`, tone: 'danger', confirmText: 'Deactivate', cancelText: 'Cancel' }))) return;
    setBusy(true);
    try {
      await api.deleteResource(form.id);
      toast.success('Resource deactivated');
      onSaved?.();
      onClose();
    } catch (e: any) {
      toast.error('Delete failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={form.id ? `Edit ${form.name || 'resource'}` : 'Create resource'}
      onClose={onClose}
      footer={<>
        {form.id && <button className="btn danger" disabled={busy} onClick={deactivate}>
          <Trash2 size={13} /> Deactivate
        </button>}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>
          <Save size={13} /> Save
        </button>
      </>}
    >
      <div className="grid-2">
        <label>Name
          <input value={form.name || ''} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label>Asset type
          <select value={form.assetType || 'Meeting Room'} onChange={(e) => patch({ assetType: e.target.value })}>
            {ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Region
          <select value={form.region || ''} onChange={(e) => patch({ region: e.target.value })}>
            <option value="">—</option>
            {REGIONS.map((r) => <option key={r}>{r}</option>)}
          </select>
        </label>
        <label>Location
          <input value={form.location || ''} onChange={(e) => patch({ location: e.target.value })}
                 placeholder="Building / floor (defaults to region)" />
        </label>
        <label>Capacity
          <input type="number" min={1} value={form.capacity || 1}
                 onChange={(e) => patch({ capacity: +e.target.value })} />
        </label>
        <label>Department
          <select value={form.departmentId || ''}
                  onChange={(e) => patch({ departmentId: e.target.value || null })}>
            <option value="">—</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      </div>

      <label>Equipment (comma separated)
        <input value={equipmentStr}
               onChange={(e) => patch({ equipment: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
               placeholder="Projector, whiteboard, video conf …" />
      </label>

      <div className="bm-box mt">
        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={hoursEnabled}
            onChange={(e) => {
              setHoursEnabled(e.target.checked);
              if (e.target.checked && !form.operatingHours) {
                patch({ operatingHours: { open: '08:00', close: '20:00' } });
              }
            }} />
          <span style={{ marginLeft: 6 }}>Restrict to operating hours</span>
        </label>
        {hoursEnabled && (
          <div className="grid-2 mt">
            <label>Opens
              <input type="time" value={form.operatingHours?.open || '08:00'}
                onChange={(e) => patch({ operatingHours: { open: e.target.value, close: form.operatingHours?.close || '20:00' } })} />
            </label>
            <label>Closes
              <input type="time" value={form.operatingHours?.close || '20:00'}
                onChange={(e) => patch({ operatingHours: { open: form.operatingHours?.open || '08:00', close: e.target.value } })} />
            </label>
          </div>
        )}
        <small className="muted">Bookings outside this window are rejected. Leave off for 24-hour availability.</small>
      </div>

      <div className="row gap mt" style={{ flexWrap: 'wrap' }}>
        <label className="row"><input type="checkbox" checked={!!form.requiresApproval}
          onChange={(e) => patch({ requiresApproval: e.target.checked })} /> Requires approval</label>
        <label className="row"><input type="checkbox" checked={!!form.isRestricted}
          onChange={(e) => patch({ isRestricted: e.target.checked })} /> Restricted</label>
        <label className="row"><input type="checkbox" checked={!!form.isActive}
          onChange={(e) => patch({ isActive: e.target.checked })} /> Active</label>
      </div>

      <div className="bm-box mt">
        <h4 style={{ margin: '0 0 6px' }}><Combine size={14} /> Booking model</h4>
        <p className="muted small">How is this space booked?</p>
        <div className="row gap" style={{ flexWrap: 'wrap' }}>
          <label className="row"><input type="radio" name="rmode" checked={mode === 'whole'} onChange={() => setMode('whole')} /> Whole only</label>
          <label className="row"><input type="radio" name="rmode" checked={mode === 'splittable'} onChange={() => setMode('splittable')} /> Splittable (sub-rooms)</label>
          <label className="row"><input type="radio" name="rmode" checked={mode === 'pods'} onChange={() => setMode('pods')} /> Pods (shared capacity)</label>
        </div>

        {mode === 'pods' && (
          <label className="mt">Concurrent capacity (pods)
            <input type="number" min={1} value={form.sharedCapacity || 1}
                   onChange={(e) => patch({ sharedCapacity: +e.target.value })} />
            <small className="muted">Up to this many independent bookings may overlap.</small>
          </label>
        )}

        {mode === 'splittable' && (
          <div className="mt">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <b>Sub-resources</b>
              <button type="button" className="btn ghost" onClick={addSub}>
                <Plus size={12} /> Add sub-resource
              </button>
            </div>
            {(form.subResources || []).length === 0 && (
              <p className="muted small">No sub-resources yet — add one to split this space.</p>
            )}
            {(form.subResources || []).map((sub, i) => (
              <div key={i} className="sub-card">
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <b>Sub-resource {i + 1}</b>
                  <button type="button" className="btn ghost danger" onClick={() => removeSub(i)}>
                    <X size={12} />
                  </button>
                </div>
                <div className="grid-2">
                  <label>Name
                    <input value={sub.name} onChange={(e) => updateSub(i, { name: e.target.value })} />
                  </label>
                  <label>Capacity
                    <input type="number" min={1} value={sub.capacity}
                           onChange={(e) => updateSub(i, { capacity: +e.target.value })} />
                  </label>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bm-box mt">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h4 style={{ margin: 0 }}>Custom fields</h4>
            <p className="muted small">Extra questions asked when booking this resource.</p>
          </div>
          <button type="button" className="btn ghost" onClick={addField}>
            <Plus size={12} /> Add field
          </button>
        </div>
        {(form.customFields || []).map((f, i) => (
          <div key={i} className="sub-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <b>Field {i + 1}</b>
              <button type="button" className="btn ghost danger" onClick={() => removeField(i)}>
                <X size={12} />
              </button>
            </div>
            <div className="grid-2">
              <label>Key
                <input value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
              </label>
              <label>Label
                <input value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
              </label>
              <label>Type
                <select value={f.type} onChange={(e) => updateField(i, { type: e.target.value as CustomField['type'] })}>
                  {FIELD_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="row" style={{ alignItems: 'center' }}>
                <Switch checked={!!f.required} onChange={(v) => updateField(i, { required: v })} />
                <span style={{ marginLeft: 6 }}>Required</span>
              </label>
            </div>
            {f.type === 'select' && (
              <label>Options (comma separated)
                <input value={(f.options || []).join(', ')}
                       onChange={(e) => updateField(i, { options: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
              </label>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
