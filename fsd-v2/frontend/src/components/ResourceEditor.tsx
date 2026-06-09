import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, X, Combine, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useTenant } from '../stores/tenant';
import { useAssetTypes } from '../hooks/useAssetTypes';
import { useRegions } from '../hooks/useRegions';
import { confirmDialog, alertDialog } from '../stores/confirm';

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
  operatingHours?: OperatingHours | null;
  ruleOverrides?: RuleOverrides | null;
  costCenterCode?: string | null;
  exchangeMailbox?: string | null;
}

// Per-resource overrides of the tenant workflow defaults. An absent key
// inherits the tenant value; requiresApproval is tri-state (absent = inherit,
// true = force, false = waive).
interface RuleOverrides {
  minDurationMinutes?: number;
  maxDurationMinutes?: number;
  bookingHorizonDays?: number;
  graceMinutes?: number;
  requiresApproval?: boolean;
}

// Per-weekday operating hours. days keyed "0"=Sun … "6"=Sat; a window = open
// that day, null = closed. Legacy { open, close } (applied to every day) is
// still read from older resources. Mirrors backend common/operating-hours.ts.
interface DayWindow { open: string; close: string }
interface OperatingHours { days?: Record<string, DayWindow | null>; open?: string; close?: string }

// Local editor row state, one per weekday index 0..6.
interface DayRow { closed: boolean; open: string; close: string }

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Display Monday-first; the underlying array stays indexed 0=Sun..6=Sat.
const WEEKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Expand any stored operatingHours (per-day or legacy) into 7 editable rows.
function toDayRows(oh: OperatingHours | null | undefined): DayRow[] {
  const rows: DayRow[] = [];
  for (let wd = 0; wd < 7; wd++) {
    let win: DayWindow | null = null;
    if (oh?.days) {
      win = Object.prototype.hasOwnProperty.call(oh.days, String(wd)) ? (oh.days[String(wd)] ?? null) : null;
    } else if (oh?.open && oh?.close) {
      win = { open: oh.open, close: oh.close }; // legacy single window → every day
    }
    rows[wd] = win
      ? { closed: false, open: win.open, close: win.close }
      : { closed: true, open: '09:00', close: '18:00' };
  }
  return rows;
}

// Sensible default when an admin first enables hours: Mon–Fri 09:00–18:00,
// weekend closed. They can adjust any day (e.g. Sat 10:00–17:00).
function defaultDayRows(): DayRow[] {
  return Array.from({ length: 7 }, (_, wd): DayRow =>
    wd >= 1 && wd <= 5
      ? { closed: false, open: '09:00', close: '18:00' }
      : { closed: true, open: '10:00', close: '17:00' });
}

// Collapse the editor rows back into the stored per-day shape.
function fromDayRows(rows: DayRow[]): OperatingHours {
  const days: Record<string, DayWindow | null> = {};
  rows.forEach((r, wd) => { days[String(wd)] = r.closed ? null : { open: r.open, close: r.close }; });
  return { days };
}

interface SubResource {
  id?: string;
  name: string;
  capacity: number;
  // Per-child overrides; left undefined the child inherits the parent's value.
  equipment?: string[];
  requiresApproval?: boolean;
}
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
  // Asset-type options come from the shared catalog hook so this list and the
  // approval-rule scope picker can't drift (QA #11). Pass the current value so a
  // legacy/custom type already on the room stays selectable.
  const assetTypes = useAssetTypes([form.assetType || ''].filter(Boolean));
  // Region options come from the shared catalog (the tenant's Locations) so the
  // room editor and the user editor offer the same admin-managed list (QA #7).
  // The room's current region is passed so a legacy value never disappears.
  const regions = useRegions([form.region || ''].filter(Boolean));

  // Sub-resource hierarchy mode: whole (standalone), splittable (parent
  // with N child rooms), or pods (one resource bookable by N people).
  type Mode = 'whole' | 'splittable' | 'pods';
  const initialMode: Mode =
    form.bookingMode === 'shared' ? 'pods'
    : (form.compositeMode === 'parent' || (form.subResources?.length ?? 0) > 0) ? 'splittable'
    : 'whole';
  const [mode, setMode] = useState<Mode>(initialMode);

  // Operating-hours toggle + per-weekday rows. On when the resource already
  // has a schedule; rows are hydrated from whatever shape was stored.
  const [hoursEnabled, setHoursEnabled] = useState<boolean>(!!resource.operatingHours);
  const [dayRows, setDayRows] = useState<DayRow[]>(() => toDayRows(resource.operatingHours));
  function setDay(wd: number, p: Partial<DayRow>) {
    setDayRows((rows) => rows.map((r, i) => (i === wd ? { ...r, ...p } : r)));
  }

  // Re-hydrate child sub-resources when editing an existing splittable parent —
  // they live as separate child rows on the server, not nested on the parent.
  useEffect(() => {
    if (resource.id && initialMode === 'splittable' && !(resource.subResources?.length)) {
      api.resourceChildren(resource.id)
        .then((kids: any[]) => patch({
          subResources: (kids || []).map((k) => ({
            id: k.id, name: k.name, capacity: k.capacity,
            equipment: k.equipment, requiresApproval: k.requiresApproval,
          })),
        }))
        .catch(() => { /* non-fatal — admin can re-add */ });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching booking model must clear the OTHER model's leftover state, or the
  // save payload ships fields from both shapes at once and the backend persists
  // a "mutant" room (e.g. sharedCapacity 10 AND a subResources list), which
  // breaks the cross-locking query in findAvailable. Pods can't carry sub-rooms;
  // a splittable/whole room can't carry a shared-pod capacity.
  useEffect(() => {
    if (mode === 'pods') {
      patch({
        bookingMode: 'shared',
        sharedCapacity: form.sharedCapacity || form.capacity || 2,
        subResources: [],
      });
    } else if (mode === 'splittable') {
      patch({ bookingMode: 'exclusive', sharedCapacity: 1 });
    } else {
      patch({ bookingMode: 'exclusive', sharedCapacity: 1, subResources: [] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  function patch(p: Partial<Resource>) { setForm((f) => ({ ...f, ...p })); }

  // Tenant-wide defaults, shown as placeholders so an admin sees what a blank
  // override field inherits. cost_centers drives the per-resource default code.
  const customization = useTenant((s) => s.customization) || {};
  const costCenters: string[] = Array.isArray(customization.cost_centers) ? customization.cost_centers : [];
  // When the tenant has Outlook/Graph sync on, the admin must map this room to
  // its Exchange mailbox (e.g. boardroomA@company.com) or two-way sync can't
  // bind the calendar. Field is hidden entirely when the integration is off.
  const outlookSync = !!customization.outlook_sync_enabled;
  const tenantDefaults = {
    min: customization.min_duration_minutes ?? 15,
    max: customization.max_duration_minutes ?? 480,
    horizon: customization.booking_horizon_days ?? 180,
    grace: customization.auto_release?.grace_minutes ?? 15,
  };
  const ov: RuleOverrides = form.ruleOverrides || {};

  // Write one override key. A blank/NaN value clears the key (inherit); when
  // the last key is removed we store null so the whole object stays absent and
  // the server treats the resource as fully inheriting the tenant rules.
  function setOverrideNum(key: keyof RuleOverrides, raw: string) {
    setForm((f) => {
      const next: RuleOverrides = { ...(f.ruleOverrides || {}) };
      const n = raw === '' ? NaN : Math.floor(Number(raw));
      if (!Number.isFinite(n) || n < 1) delete next[key];
      else (next as Record<string, number>)[key] = n;
      return { ...f, ruleOverrides: Object.keys(next).length ? next : null };
    });
  }

  function addSub() {
    const next: SubResource = {
      name: `${form.name || 'Sub-resource'} ${((form.subResources?.length ?? 0) + 1)}`,
      capacity: form.capacity || 4,
    };
    patch({ subResources: [...(form.subResources || []), next] });
  }
  async function removeSub(i: number) {
    const sub = (form.subResources || [])[i];
    // A sub-room that already exists on the server may hold future bookings.
    // Removing it would soft-deactivate the child and strand those bookings on
    // an invisible room (the backend now rejects this outright). Pre-check and
    // block here with a reassign/cancel-first path so the admin isn't surprised
    // by a failed save (spec: "cannot remove a child that has future bookings").
    if (sub?.id) {
      try {
        const { count } = await api.resourceFutureBookings(sub.id);
        if (count > 0) {
          await alertDialog({
            title: `Can't remove "${sub.name}"`,
            tone: 'danger',
            message: `This sub-room has ${count} future booking(s). Reassign or cancel `
              + 'them first, then remove the sub-room.',
            confirmText: 'Got it',
          });
          return;
        }
      } catch {
        // If the check itself fails, fall through — the server guard is the
        // authoritative backstop and will reject an unsafe removal on save.
      }
    }
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
    // Region is mandatory: an unregioned room can't be region-scoped for
    // dashboards, approvals or user region-access, and used to be silently
    // saveable as null (QA #8). Force a choice from the managed region list.
    if (!form.region?.trim()) { toast.warning('Region is required'); return; }
    // Custom-field keys are the JSONB object keys stored on every booking of
    // this resource, so a duplicate key silently clobbers a sibling field's
    // answer ({ cc: "A", cc: "B" } collapses to { cc: "B" }) before it reaches
    // the API. Require a key on every field and block any repeat.
    const fieldKeys = (form.customFields || []).map((f) => (f.key || '').trim());
    if (fieldKeys.some((k) => !k)) { toast.warning('Every custom field needs a key'); return; }
    const dupFieldKey = fieldKeys.find((k, i) => fieldKeys.indexOf(k) !== i);
    if (dupFieldKey) { toast.warning(`Custom field key "${dupFieldKey}" is used more than once — keys must be unique`); return; }
    // Operating hours are optional; when enabled, validate each open day's
    // window (close after open) and require at least one open day.
    if (hoursEnabled) {
      for (let wd = 0; wd < 7; wd++) {
        const r = dayRows[wd];
        if (r.closed) continue;
        if (!r.open || !r.close) { toast.warning(`Set open and close for ${WEEKDAY_LABELS[wd]}`); return; }
        if (r.close <= r.open) { toast.warning(`${WEEKDAY_LABELS[wd]}: close must be after open`); return; }
      }
      if (dayRows.every((r) => r.closed)) {
        toast.warning('Set hours for at least one day, or turn off operating-hour restriction'); return;
      }
    }
    // Override sanity: a min > max override would silently reject every
    // booking of this room, so block the save the same way the server would.
    if (ov.minDurationMinutes && ov.maxDurationMinutes && ov.minDurationMinutes > ov.maxDurationMinutes) {
      toast.warning('Min duration override cannot exceed the max duration override'); return;
    }
    // Capacity guardrail (spec: "cannot save if Σ child capacity is wildly >
    // parent — warn, allow with confirm"). The sub-rooms partition the parent,
    // so their combined seats exceeding the parent's is physically suspect.
    // Warn and let the admin confirm rather than blocking outright.
    if (mode === 'splittable') {
      const subs = form.subResources || [];
      const sumChildren = subs.reduce((n, s) => n + (Number(s.capacity) || 0), 0);
      const parentCap = Number(form.capacity) || 0;
      if (subs.length > 0 && parentCap > 0 && sumChildren > parentCap) {
        const ok = await confirmDialog({
          title: 'Sub-room capacity exceeds the parent',
          tone: 'danger',
          message: `The sub-rooms add up to ${sumChildren} seats but "${form.name}" holds `
            + `${parentCap}. That's usually a mistake. Save anyway?`,
          confirmText: 'Save anyway',
          cancelText: 'Go back',
        });
        if (!ok) return;
      }
    }
    // Build the payload explicitly so we control exactly what is sent: blank
    // location falls back to region (keeps the server equality filter happy),
    // and operatingHours is the per-day schedule unless the toggle is off.
    const payload: Resource = {
      ...form,
      location: form.location?.trim() || form.region || '',
      operatingHours: hoursEnabled ? fromDayRows(dayRows) : null,
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
          {busy ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save
        </button>
      </>}
    >
      <div className="grid-2">
        <label>Name
          <input value={form.name || ''} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <label>Asset type
          <select value={form.assetType || 'Meeting Room'} onChange={(e) => patch({ assetType: e.target.value })}>
            {assetTypes.map((t) => <option key={t}>{t}</option>)}
          </select>
        </label>
        <label>Region*
          <select value={form.region || ''} onChange={(e) => patch({ region: e.target.value })}>
            <option value="">—</option>
            {regions.map((r) => <option key={r}>{r}</option>)}
          </select>
          <small className="muted">Required · managed under Admin → Locations.</small>
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

      {outlookSync && (
        <label>Exchange mailbox
          <input type="email" value={form.exchangeMailbox || ''}
                 onChange={(e) => patch({ exchangeMailbox: e.target.value })}
                 placeholder="boardroomA@company.com" />
          <small className="muted">Microsoft 365 room mailbox this resource maps to for two-way calendar sync.</small>
        </label>
      )}

      <div className="bm-box mt">
        <label className="row" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={hoursEnabled}
            onChange={(e) => {
              const on = e.target.checked;
              setHoursEnabled(on);
              // Seed sensible defaults the first time hours are enabled on a
              // resource that has none yet (Mon–Fri 09:00–18:00, weekend closed).
              if (on && !resource.operatingHours && dayRows.every((r) => r.closed)) {
                setDayRows(defaultDayRows());
              }
            }} />
          <span style={{ marginLeft: 6 }}>Restrict to operating hours</span>
        </label>
        {hoursEnabled && (
          <div className="oh-grid mt" style={{ display: 'grid', gap: 6 }}>
            {WEEKDAY_DISPLAY_ORDER.map((wd) => {
              const r = dayRows[wd];
              return (
                <div key={wd} className="row" style={{ alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 42, fontWeight: 600 }}>{WEEKDAY_LABELS[wd]}</span>
                  <label className="row" style={{ alignItems: 'center', gap: 4, width: 86 }}>
                    <input type="checkbox" checked={!r.closed}
                      onChange={(e) => setDay(wd, { closed: !e.target.checked })} />
                    <span className="muted">{r.closed ? 'Closed' : 'Open'}</span>
                  </label>
                  <input type="time" value={r.open} disabled={r.closed}
                    onChange={(e) => setDay(wd, { open: e.target.value })}
                    style={{ width: 150, opacity: r.closed ? 0.5 : 1 }} />
                  <span className="muted">–</span>
                  <input type="time" value={r.close} disabled={r.closed}
                    onChange={(e) => setDay(wd, { close: e.target.value })}
                    style={{ width: 150, opacity: r.closed ? 0.5 : 1 }} />
                </div>
              );
            })}
          </div>
        )}
        <small className="muted">
          Set open/close per day; untick a day to mark it closed. Bookings outside a day's
          window — or on a closed day — are rejected. Leave the whole option off for 24-hour availability.
        </small>
      </div>

      <div className="row gap mt" style={{ flexWrap: 'wrap' }}>
        <label className="row"><input type="checkbox" checked={!!form.requiresApproval}
          onChange={(e) => patch({ requiresApproval: e.target.checked })} /> Requires approval</label>
        <label className="row"><input type="checkbox" checked={!!form.isRestricted}
          onChange={(e) => patch({ isRestricted: e.target.checked })} /> Restricted</label>
        <label className="row"><input type="checkbox" checked={!!form.isActive}
          onChange={(e) => patch({ isActive: e.target.checked })} /> Active</label>
      </div>
      {/* Spell out who a restricted room is actually bookable by, and let the
          admin control it via the Department selector above — previously
          "Restricted" was an opaque checkbox with no way to say WHO it was
          restricted to, and the room was still hidden from / rejected for the
          wrong people (QA #9). Restricted + a department = that department's
          members (plus admins); restricted with no department = admins only. */}
      {form.isRestricted && (
        <p className="muted small" style={{ marginTop: 6 }}>
          {form.departmentId
            ? <>🔒 Bookable only by <b>{departments.find((d) => d.id === form.departmentId)?.name || 'the selected department'}</b> members and administrators. Restricted rooms are hidden from everyone else in search.</>
            : <>🔒 Bookable by <b>administrators only</b>. Pick a <b>Department</b> above to also let that group book it. Restricted rooms are hidden from everyone else in search.</>}
        </p>
      )}

      <div className="bm-box mt">
        <h4 style={{ margin: '0 0 4px' }}>Booking rule overrides</h4>
        <p className="muted small">
          Leave a field blank to inherit the tenant default (shown as the placeholder).
          Set a value to override it for this resource only — e.g. cap the boardroom at 120 min.
        </p>
        <div className="grid-2">
          <label>Min duration (min)
            <input type="number" min={1} value={ov.minDurationMinutes ?? ''}
              placeholder={`inherit · ${tenantDefaults.min}`}
              onChange={(e) => setOverrideNum('minDurationMinutes', e.target.value)} />
          </label>
          <label>Max duration (min)
            <input type="number" min={1} value={ov.maxDurationMinutes ?? ''}
              placeholder={`inherit · ${tenantDefaults.max}`}
              onChange={(e) => setOverrideNum('maxDurationMinutes', e.target.value)} />
          </label>
          <label>Booking horizon (days)
            <input type="number" min={1} value={ov.bookingHorizonDays ?? ''}
              placeholder={`inherit · ${tenantDefaults.horizon}`}
              onChange={(e) => setOverrideNum('bookingHorizonDays', e.target.value)} />
          </label>
          <label>Auto-release grace (min)
            <input type="number" min={1} value={ov.graceMinutes ?? ''}
              placeholder={`inherit · ${tenantDefaults.grace}`}
              onChange={(e) => setOverrideNum('graceMinutes', e.target.value)} />
          </label>
        </div>
        {costCenters.length > 0 && (
          <label className="mt">Default cost center
            <select value={form.costCenterCode || ''}
              onChange={(e) => patch({ costCenterCode: e.target.value || null })}>
              <option value="">— none —</option>
              {costCenters.map((cc) => <option key={cc} value={cc}>{cc}</option>)}
            </select>
            <small className="muted">Pre-fills the chargeback code when this resource is booked.</small>
          </label>
        )}
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
                {/* Per-child overrides (spec: equipment / approver inherit from
                    the parent then override). Blank equipment inherits the
                    parent's kit; the approval toggle forces approval on this
                    sub-room only. */}
                <label>Equipment (comma separated)
                  <input
                    value={(sub.equipment || []).join(', ')}
                    onChange={(e) => updateSub(i, {
                      equipment: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                    })}
                    placeholder={(form.equipment || []).length
                      ? `inherits · ${(form.equipment || []).join(', ')}`
                      : 'Projector, whiteboard …'} />
                </label>
                <label className="row" style={{ alignItems: 'center', marginTop: 6 }}>
                  <input type="checkbox" checked={!!sub.requiresApproval}
                    onChange={(e) => updateSub(i, { requiresApproval: e.target.checked })} />
                  <span style={{ marginLeft: 6 }}>Requires approval</span>
                </label>
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
