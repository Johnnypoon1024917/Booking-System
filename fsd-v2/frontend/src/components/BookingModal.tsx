import { useEffect, useMemo, useState } from 'react';
import { Building2, Calendar, Clock, Check, Loader2, Repeat, Lock } from 'lucide-react';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useTenant } from '../stores/tenant';
import { useBookingRules } from '../hooks/useBookingRules';
import { useTimezone } from '../hooks/useTimezone';
import { useT } from '../hooks/useT';

interface CustomField {
  key: string;
  label?: string;
  type?: 'text' | 'number' | 'select' | 'date' | 'checkbox';
  required?: boolean;
  options?: string[];
}

interface Resource {
  id?: string;
  ID?: string;
  name?: string;
  Name?: string;
  location?: string;
  Location?: string;
  capacity?: number;
  Capacity?: number;
  requiresApproval?: boolean;
  RequiresApproval?: boolean;
  customFields?: CustomField[];
}

interface Props {
  resource?: Resource;       // pre-selected room (optional — Teams-style: pick inside the dialog)
  resources?: Resource[];    // full list to choose from when no room is pre-selected
  date: string;          // YYYY-MM-DD
  start: string;         // HH:MM
  end: string;           // HH:MM
  onClose: () => void;
  onBooked?: (booking: any) => void;
}

function rId(r: Resource) { return r.id || r.ID || ''; }
function rName(r: Resource) { return r.name || r.Name || ''; }

// Dedicated booking dialog — replaces the inline calendar prompt.
// Surfaces title, recurrence, services add-ons, the private flag and
// the meeting URL inside one form so the user only confirms once.
// Validates against the tenant rule set via useBookingRules so the SPA
// matches the server-side guard. When no room is pre-selected the dialog
// shows a resource picker so the user can drag any open slot and choose
// the room here (Teams-style), rather than filtering first.
export function BookingModal({ resource, resources, date, start, end, onClose, onBooked }: Props) {
  const toast = useToast();
  const { validate, allowsPattern } = useBookingRules();
  const tz = useTimezone();
  const { t } = useT();

  const choices = resources ?? (resource ? [resource] : []);
  const [selResId, setSelResId] = useState(resource ? rId(resource) : '');

  const [title, setTitle] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [recur, setRecur] = useState(false);
  const [pattern, setPattern] = useState<'daily' | 'weekly' | 'bi-weekly' | 'monthly'>('weekly');
  const [count, setCount] = useState(4);
  const [until, setUntil] = useState('');   // optional end-date for the series (QA #7)
  const [services, setServices] = useState<string[]>([]);
  const [cfValues, setCfValues] = useState<Record<string, any>>({});
  const [costCenter, setCostCenter] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

  // Tenant chargeback codes. When the tenant has configured any, a code is
  // required for every booking (the server re-checks against the same list).
  const customization = useTenant((s) => s.customization);
  const costCenters: string[] = Array.isArray(customization?.cost_centers) ? customization!.cost_centers : [];

  const ruleError = useMemo(() => validate({ date, start, end }), [date, start, end, validate]);

  const selected = useMemo(
    () => choices.find((r) => rId(r) === selResId),
    [choices, selResId]
  );

  const resName  = selected ? rName(selected) : '';
  const resLoc   = selected ? (selected.location || selected.Location || '') : '';
  const resCap   = selected ? (selected.capacity || selected.Capacity || 0) : 0;
  const resId    = selResId;
  const needsApproval = !!(selected && (selected.requiresApproval ?? selected.RequiresApproval));
  const showPicker = choices.length > 1 || !resource;

  // Custom booking-form fields are defined per resource; reset answers
  // whenever the selected resource changes so a different room never
  // inherits the previous one's answers.
  const customFields = selected?.customFields || [];
  useEffect(() => {
    setCfValues({});
    // Pre-fill the chargeback code from the resource's default (if any and
    // still valid for the tenant), so the common case is one click.
    const def = (selected as any)?.costCenterCode || '';
    setCostCenter(def && costCenters.includes(def) ? def : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selResId]);
  function setCf(key: string, value: any) { setCfValues((m) => ({ ...m, [key]: value })); }

  // Pre-defined service add-ons — admins can override these via the
  // tenant studio later; for now this matches v1's hard-coded list.
  const SERVICE_OPTIONS = ['Catering', 'IT setup', 'AV equipment', 'Whiteboard'];

  function toggleService(opt: string) {
    setServices((arr) => (arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt]));
  }

  function formatDate(d: string) {
    if (!d) return '';
    return new Date(`${d}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long', month: 'short', day: 'numeric',
    });
  }

  async function submit() {
    if (ruleError) { toast.error(t('bookingModal.cannotBook'), ruleError); return; }
    if (!resId) { toast.warning(t('bookingModal.pickResource')); return; }
    if (!title.trim()) { toast.warning(t('bookingModal.titleRequired')); return; }
    // Enforce required custom fields client-side (the server re-checks).
    for (const f of customFields) {
      if (!f.required) continue;
      const v = cfValues[f.key];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) { toast.warning(t('bookingModal.requiredField', { field: f.label || f.key })); return; }
    }
    if (costCenters.length && !costCenter) {
      toast.warning(t('bookingModal.requiredField', { field: 'Cost center' })); return;
    }
    const customFieldValues = Object.keys(cfValues).length ? cfValues : undefined;
    setBusy(true);
    try {
      // Lock the wall-clock slot to the tenant zone (not the browser's) so a
      // traveller doesn't silently book a different instant than the labelled
      // "times shown in <zone>" (QA #1).
      const startIso = tz.toUtcIso(date, start);
      const endIso = tz.toUtcIso(date, end);
      let r: any;
      if (recur) {
        // Recurring bookings go to the dedicated /bookings/recurring
        // endpoint — the plain /bookings create() silently ignores the
        // recurrence block, so the series never materialised (QA #4).
        r = await api.createRecurringBooking({
          resourceId: resId,
          firstStart: startIso,
          firstEnd: endIso,
          pattern,
          // End the series either by a fixed occurrence count or by an
          // explicit until-date — mirrors the NewBooking wizard (QA #7).
          count: until ? undefined : count,
          until: until ? tz.toUtcIso(until, '23:59:59') : undefined,
          title: title.trim(),
          meetingUrl: meetingUrl.trim() || undefined,
          isPrivate,
          customFieldValues,
          costCenterCode: costCenter || undefined,
        });
      } else {
        r = await api.createBooking({
          resourceId: resId,
          startTime: startIso,
          endTime: endIso,
          title: title.trim(),
          meetingUrl: meetingUrl.trim() || undefined,
          isPrivate,
          services: services.length ? services : undefined,
          customFieldValues,
          costCenterCode: costCenter || undefined,
        });
      }
      setResult(r || { status: 'Confirmed' });
      toast.success(recur ? t('bookingModal.recurringSubmitted') : t('bookingModal.submitted'));
      // Leave the confirmation on screen; the footer swaps to a "Done" button
      // so the user reads the result and dismisses it themselves (QA #2).
    } catch (e: any) {
      toast.error(t('bookingModal.bookingFailed'), e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={t('bookingModal.confirmTitle')}
      onClose={onClose}
      footer={result ? <>
        <span className="spacer" />
        <button className="btn primary" onClick={() => { onBooked?.(result); onClose(); }}>
          {t('bookingModal.done')}
        </button>
      </> : <>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !!ruleError || !resId} onClick={submit}>
          {busy && <Loader2 size={14} className="spin" />} {t('bookingModal.confirm')}
        </button>
      </>}
    >
      <div className="bm-summary">
        <div className="bm-thumb"><Building2 size={20} color="white" /></div>
        <div style={{ flex: 1 }}>
          {showPicker ? (
            <label style={{ margin: 0 }}>{t('bookingModal.resource')}*
              <select value={selResId} onChange={(e) => setSelResId(e.target.value)}>
                <option value="">{t('bookingModal.chooseResource')}</option>
                {choices.map((r) => (
                  <option key={rId(r)} value={rId(r)}>
                    {rName(r)}{(r.location || r.Location) ? ` · ${r.location || r.Location}` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <h3 style={{ margin: 0 }}>{resName}</h3>
          )}
          {selected && (
            <small className="muted">{resLoc}{resCap ? ` · ${t('bookingModal.pax', { n: resCap })}` : ''}</small>
          )}
        </div>
      </div>

      <div className="bm-timerow">
        <span><Calendar size={14} /> {formatDate(date)}</span>
        <span><Clock size={14} /> {start} – {end}</span>
        <span className={`tag ${needsApproval ? 'warning' : 'ok'}`}>
          {needsApproval ? t('bookingModal.requiresApproval') : t('bookingModal.autoApproved')}
        </span>
      </div>
      {/* Always state the zone the slot is in — these times are the tenant's
          local wall-clock, which may differ from the viewer's browser zone. */}
      <small className="muted" style={{ display: 'block', marginTop: -4 }}>
        {t('bookingModal.timesShownIn', { zone: tz.label })}
      </small>

      <label>{t('bookingModal.fieldTitle')}*
        <input value={title} onChange={(e) => setTitle(e.target.value)}
               placeholder={t('bookingModal.titlePlaceholder')} />
      </label>

      <label>{t('bookingModal.meetingUrl')}
        <input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)}
               placeholder="https://teams.microsoft.com/…" />
      </label>

      {costCenters.length > 0 && (
        <label>Cost center*
          <select value={costCenter} onChange={(e) => setCostCenter(e.target.value)}>
            <option value="">Choose a cost center…</option>
            {costCenters.map((cc) => <option key={cc} value={cc}>{cc}</option>)}
          </select>
        </label>
      )}

      <div className="field">
        <label>{t('bookingModal.services')}</label>
        <div className="chip-grid">
          {SERVICE_OPTIONS.map((opt) => (
            <label key={opt} className="dep-chip">
              <input type="checkbox" checked={services.includes(opt)} onChange={() => toggleService(opt)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      {/* Resource-defined custom fields. Rendered by type; required ones are
          enforced on submit (and again server-side). */}
      {customFields.map((f) => {
        const label = `${f.label || f.key}${f.required ? '*' : ''}`;
        if (f.type === 'checkbox') {
          return (
            <label key={f.key} className="row" style={{ alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={!!cfValues[f.key]}
                     onChange={(e) => setCf(f.key, e.target.checked)} />
              <span>{label}</span>
            </label>
          );
        }
        if (f.type === 'select') {
          return (
            <label key={f.key}>{label}
              <select value={cfValues[f.key] ?? ''} onChange={(e) => setCf(f.key, e.target.value)}>
                <option value="">{t('bookingModal.choose')}</option>
                {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </label>
          );
        }
        return (
          <label key={f.key}>{label}
            <input
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              value={cfValues[f.key] ?? ''}
              onChange={(e) => setCf(f.key, f.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value)}
            />
          </label>
        );
      })}

      <div className="field bm-box">
        <div className="row gap" style={{ alignItems: 'center' }}>
          <Switch checked={recur} onChange={setRecur} label={t('bookingModal.recurring')} />
          <span><Repeat size={13} /> {t('bookingModal.makeRecurring')}</span>
        </div>
        {recur && (
          <div className="grid-2 mt">
            <label>{t('bookingModal.pattern')}
              <select value={pattern} onChange={(e) => setPattern(e.target.value as any)}>
                {allowsPattern('daily')   && <option value="daily">{t('bookingModal.daily')}</option>}
                {allowsPattern('weekly')  && <option value="weekly">{t('bookingModal.weekly')}</option>}
                {allowsPattern('weekly')  && <option value="bi-weekly">{t('bookingModal.biweekly')}</option>}
                {allowsPattern('monthly') && <option value="monthly">{t('bookingModal.monthly')}</option>}
              </select>
            </label>
            <label>{t('bookingModal.occurrences')}
              <input type="number" min={1} max={100} value={count}
                     onChange={(e) => setCount(+e.target.value || 1)} disabled={!!until} />
            </label>
            <label>{t('bookingModal.until')} <span className="muted">({t('bookingModal.or')})</span>
              <input type="date" value={until} min={date}
                     onChange={(e) => setUntil(e.target.value)} />
            </label>
          </div>
        )}
      </div>

      <div className="row gap mt" style={{ alignItems: 'center' }}>
        <Switch checked={isPrivate} onChange={setPrivate} label={t('bookingModal.private')} />
        <span><Lock size={13} /> {t('bookingModal.privateHint')}</span>
      </div>

      {result && (
        <div className="bm-result mt">
          <Check size={16} />
          <div>
            <b>{result.requires_approval ? t('bookingModal.pendingApproval') : t('bookingModal.confirmed')}</b>
            <p className="muted small">
              {result.requires_approval
                ? t('bookingModal.pendingHint')
                : t('bookingModal.confirmedHint')}
            </p>
          </div>
        </div>
      )}

      {ruleError && <div className="err mt">{ruleError}</div>}
    </Modal>
  );
}
