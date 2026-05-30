import { useMemo, useState } from 'react';
import { Building2, Calendar, Clock, Check, Loader2, Repeat, Lock } from 'lucide-react';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useBookingRules } from '../hooks/useBookingRules';

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

  const choices = resources ?? (resource ? [resource] : []);
  const [selResId, setSelResId] = useState(resource ? rId(resource) : '');

  const [title, setTitle] = useState('');
  const [meetingUrl, setMeetingUrl] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [recur, setRecur] = useState(false);
  const [pattern, setPattern] = useState<'daily' | 'weekly' | 'bi-weekly' | 'monthly'>('weekly');
  const [count, setCount] = useState(4);
  const [services, setServices] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);

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
    if (ruleError) { toast.error('Cannot book', ruleError); return; }
    if (!resId) { toast.warning('Pick a resource'); return; }
    if (!title.trim()) { toast.warning('Title required'); return; }
    setBusy(true);
    try {
      const startIso = new Date(`${date}T${start}:00`).toISOString();
      const endIso = new Date(`${date}T${end}:00`).toISOString();
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
          count,
          title: title.trim(),
          meetingUrl: meetingUrl.trim() || undefined,
          isPrivate,
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
        });
      }
      setResult(r || { status: 'Confirmed' });
      toast.success(recur ? 'Recurring booking submitted' : 'Booking submitted');
      setTimeout(() => { onBooked?.(r); onClose(); }, 900);
    } catch (e: any) {
      toast.error('Booking failed', e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title="Confirm booking"
      onClose={onClose}
      footer={<>
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !!result || !!ruleError || !resId} onClick={submit}>
          {busy && <Loader2 size={14} className="spin" />} Confirm booking
        </button>
      </>}
    >
      <div className="bm-summary">
        <div className="bm-thumb"><Building2 size={20} color="white" /></div>
        <div style={{ flex: 1 }}>
          {showPicker ? (
            <label style={{ margin: 0 }}>Resource*
              <select value={selResId} onChange={(e) => setSelResId(e.target.value)}>
                <option value="">Choose a resource…</option>
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
            <small className="muted">{resLoc}{resCap ? ` · ${resCap} pax` : ''}</small>
          )}
        </div>
      </div>

      <div className="bm-timerow">
        <span><Calendar size={14} /> {formatDate(date)}</span>
        <span><Clock size={14} /> {start} – {end}</span>
        <span className={`tag ${needsApproval ? 'warning' : 'ok'}`}>
          {needsApproval ? 'Requires approval' : 'Auto-approved'}
        </span>
      </div>

      <label>Title*
        <input value={title} onChange={(e) => setTitle(e.target.value)}
               placeholder="e.g. Weekly team sync" />
      </label>

      <label>Meeting URL
        <input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)}
               placeholder="https://teams.microsoft.com/…" />
      </label>

      <div className="field">
        <label>Services / add-ons</label>
        <div className="chip-grid">
          {SERVICE_OPTIONS.map((opt) => (
            <label key={opt} className="dep-chip">
              <input type="checkbox" checked={services.includes(opt)} onChange={() => toggleService(opt)} />
              {opt}
            </label>
          ))}
        </div>
      </div>

      <div className="field bm-box">
        <div className="row gap" style={{ alignItems: 'center' }}>
          <Switch checked={recur} onChange={setRecur} label="Recurring" />
          <span><Repeat size={13} /> Make this recurring</span>
        </div>
        {recur && (
          <div className="grid-2 mt">
            <label>Pattern
              <select value={pattern} onChange={(e) => setPattern(e.target.value as any)}>
                {allowsPattern('daily')   && <option value="daily">Daily</option>}
                {allowsPattern('weekly')  && <option value="weekly">Weekly</option>}
                {allowsPattern('weekly')  && <option value="bi-weekly">Bi-weekly</option>}
                {allowsPattern('monthly') && <option value="monthly">Monthly</option>}
              </select>
            </label>
            <label>Occurrences
              <input type="number" min={1} max={100} value={count}
                     onChange={(e) => setCount(+e.target.value || 1)} />
            </label>
          </div>
        )}
      </div>

      <div className="row gap mt" style={{ alignItems: 'center' }}>
        <Switch checked={isPrivate} onChange={setPrivate} label="Private appointment" />
        <span><Lock size={13} /> Mark as private (hide subject from other viewers)</span>
      </div>

      {result && (
        <div className="bm-result mt">
          <Check size={16} />
          <div>
            <b>{result.requires_approval ? 'Pending approval' : 'Booking confirmed'}</b>
            <p className="muted small">
              {result.requires_approval
                ? 'A room admin will review this shortly.'
                : 'You\'ll get an email confirmation in a moment.'}
            </p>
          </div>
        </div>
      )}

      {ruleError && <div className="err mt">{ruleError}</div>}
    </Modal>
  );
}
