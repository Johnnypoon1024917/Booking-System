import { useEffect, useMemo, useState } from 'react';
import { Building2, Calendar, Clock, Check, Loader2, Repeat, Lock, Trash2, CalendarClock, SlidersHorizontal, ChevronRight } from 'lucide-react';
import { Modal } from './Modal';
import { Switch } from './Switch';
import { Combobox } from './Combobox';
import { tip } from '../stores/tooltip';
import { ApprovalTimeline } from './ApprovalTimeline';
import { api } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../stores/toast';
import { useTenant } from '../stores/tenant';
import { useBookingRules } from '../hooks/useBookingRules';
import { useTimezone } from '../hooks/useTimezone';
import { useT } from '../hooks/useT';
import { promptDialog } from '../stores/confirm';
import { useBookingDraft } from '../stores/bookingDraft';

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
  bookings?: any[];          // existing bookings (any room) — drives free/busy filtering
  // When set, the dialog opens in *edit* mode: fields are pre-filled from this
  // booking and submit() calls updateBooking instead of create. Editing is
  // scoped to what UpdateBookingDto accepts (time + title + meeting URL); the
  // room, privacy, recurrence and extras are create-only and stay hidden.
  existingBooking?: any;
  date: string;          // YYYY-MM-DD  (initial; editable in the dialog)
  start: string;         // HH:MM       (initial; editable in the dialog)
  end: string;           // HH:MM       (initial; editable in the dialog)
  // Recurrence seeds from a caller that already collected the pattern (e.g. the
  // Search page's "Repeating Schedule" panel). Without these the dialog opened
  // with recur=false and silently discarded the user's choices. Ignored in edit
  // mode (recurrence is create-only).
  initialRecur?: boolean;
  initialPattern?: 'daily' | 'weekly' | 'bi-weekly' | 'monthly';
  initialUntil?: string; // YYYY-MM-DD series end-date
  onClose: () => void;
  onBooked?: (booking: any) => void;
}

function rId(r: Resource) { return r.id || r.ID || ''; }
function rName(r: Resource) { return r.name || r.Name || ''; }

function hmToMin(hhmm: string) { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0); }

// Scheduling assistant (Teams-style free/busy grid): a single-day horizontal
// timeline for the chosen room showing existing bookings as red blocks and the
// proposed slot as a blue outline, so the user can see the open "white space"
// at a glance instead of reading a busy/free sentence. All values are
// minute-of-day in the tenant zone.
function FreeBusyTimeline({ winStart, winEnd, busy, slotStart, slotEnd, conflict }: {
  winStart: number; winEnd: number;
  busy: { start: number; end: number; title: string }[];
  slotStart: number; slotEnd: number; conflict: boolean;
}) {
  const span = Math.max(1, winEnd - winStart);
  const left = (m: number) => `${((Math.min(Math.max(m, winStart), winEnd) - winStart) / span) * 100}%`;
  const width = (a: number, b: number) => `${((Math.min(b, winEnd) - Math.max(a, winStart)) / span) * 100}%`;
  const ticks: number[] = [];
  for (let h = Math.ceil(winStart / 60); h * 60 <= winEnd; h++) ticks.push(h);
  // Minute-of-day → HH:MM, for the instant hover tooltips (replacing the sluggish
  // ~1.5s native `title` the audit flagged).
  const hhmm = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(Math.round(m % 60))}`;
  return (
    <div className="bm-fb-track">
      {ticks.map((h) => (
        <div key={h} className="bm-fb-tick" style={{ left: left(h * 60) }}><span>{pad2(h)}</span></div>
      ))}
      {busy.map((b, i) => (
        <div key={i} className="bm-fb-busy" style={{ left: left(b.start), width: width(b.start, b.end) }}
             {...tip(`${hhmm(b.start)}–${hhmm(b.end)} · ${b.title}`)} />
      ))}
      <div className={`bm-fb-slot${conflict ? ' conflict' : ''}`} style={{ left: left(slotStart), width: width(slotStart, slotEnd) }}
           {...tip(`${hhmm(slotStart)}–${hhmm(slotEnd)} · your slot`)} />
    </div>
  );
}

// The nth occurrence date (YYYY-MM-DD) of a recurrence starting at `dateStr`.
// Mirrors the backend's stepping so the modal can preview conflicts before the
// series is submitted. n=0 is the first booking. Monthly snaps the day-of-month
// down to the days the target month actually has (Jan 31 → Feb 28, not a
// rolled-over Mar 3), matching RecurrenceService; the server is still the
// source of truth for the materialised dates.
function pad2(n: number) { return String(n).padStart(2, '0'); }
function occurrenceDate(dateStr: string, pattern: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (pattern === 'monthly') {
    const maxDom = new Date(y, m - 1 + n + 1, 0).getDate(); // day 0 of next month
    const base = new Date(y, m - 1 + n, Math.min(d, maxDom));
    return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
  }
  const base = new Date(y, m - 1, d + n * (pattern === 'daily' ? 1 : pattern === 'bi-weekly' ? 14 : 7));
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
}

// Dedicated booking dialog — replaces the inline calendar prompt.
// Surfaces title, recurrence, services add-ons, the private flag and
// the meeting URL inside one form so the user only confirms once.
// Validates against the tenant rule set via useBookingRules so the SPA
// matches the server-side guard. When no room is pre-selected the dialog
// shows a resource picker so the user can drag any open slot and choose
// the room here (Teams-style), rather than filtering first.
export function BookingModal({ resource, resources, bookings, existingBooking, date, start, end, initialRecur, initialPattern, initialUntil, onClose, onBooked }: Props) {
  const toast = useToast();
  const { validate, allowsPattern } = useBookingRules();
  const tz = useTimezone();
  const { t } = useT();
  const authUser = useAuth((s) => s.user);

  const isEdit = !!existingBooking;
  // A booking that belongs to a recurring series — editing/cancelling it offers
  // a "this event vs. entire series" scope choice (Outlook/Teams parity).
  const isRecurringInstance = isEdit && !!existingBooking?.recurrenceId;
  const [editScope, setEditScope] = useState<'single' | 'series'>('single');
  const choices = resources ?? (resource ? [resource] : []);
  // In edit mode the room is fixed to the booking's own resource (UpdateBookingDto
  // has no resourceId — a move would silently no-op), so seed from it.
  const [selResId, setSelResId] = useState(existingBooking?.resourceId || (resource ? rId(resource) : ''));

  // Date/time are editable in the dialog. For a new booking they're seeded from
  // the calendar drag; for an edit they're the booking's stored instant split
  // back into tenant-zone wall-clock so the fields match the calendar.
  const editStart = existingBooking ? tz.toParts(existingBooking.startTime) : null;
  const editEnd = existingBooking ? tz.toParts(existingBooking.endTime) : null;
  const [bDate, setBDate] = useState(editStart ? editStart.date : date);
  const [bStart, setBStart] = useState(editStart ? editStart.time : start);
  const [bEnd, setBEnd] = useState(editEnd ? editEnd.time : end);

  // Restore the persisted draft (QA enterprise #4) for a NEW booking so a
  // conflict-and-retry — or simply closing and reopening on another room —
  // doesn't wipe the laborious content. Read once at mount (getState, no
  // subscription); the sync effect below writes changes straight back. Edit
  // mode never uses the draft (it's seeded from the existing booking).
  const draft0 = isEdit ? null : useBookingDraft.getState().draft;
  const [title, setTitle] = useState(existingBooking?.title || draft0?.title || '');
  const [meetingUrl, setMeetingUrl] = useState(existingBooking?.meetingUrl || draft0?.meetingUrl || '');
  const [isPrivate, setPrivate] = useState(draft0 ? draft0.isPrivate : !!existingBooking?.isPrivate);
  // Seed recurrence from the draft, else from the caller (Search page), but
  // never in edit mode where the recurrence UI is hidden and a series can't be
  // created.
  const [recur, setRecur] = useState(!isEdit && (draft0?.recur ?? !!initialRecur));
  const [pattern, setPattern] = useState<'daily' | 'weekly' | 'bi-weekly' | 'monthly'>(draft0?.pattern || initialPattern || 'weekly');
  const [count, setCount] = useState(draft0?.count ?? 4);
  const [until, setUntil] = useState(draft0?.until ?? (initialUntil || ''));   // optional end-date for the series (QA #7)
  // Seed from the booking in edit mode so existing add-ons show pre-ticked and
  // can be changed (services are now editable post-creation); otherwise from the
  // saved draft so add-ons survive a room switch.
  const [services, setServices] = useState<string[]>(existingBooking?.services || draft0?.services || []);
  const [cfValues, setCfValues] = useState<Record<string, any>>(draft0?.cfValues || {});
  const [costCenter, setCostCenter] = useState(draft0?.costCenter || '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any | null>(null);
  // Inline field-level validation. Enterprise forms surface "missing Cost
  // center" right under the control, not as a corner toast the user has to hunt
  // the matching field for. Keyed by custom-field key, plus 'costCenter'.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Clear a single field's error the moment the user supplies a value.
  function clearError(key: string) {
    setFieldErrors((e) => { if (!e[key]) return e; const { [key]: _, ...rest } = e; return rest; });
  }
  // Secondary inputs (cost center, services, custom fields) collapse behind an
  // "Add-ons & details" toggle so a quick 30-minute booking isn't a wall of
  // fields. Auto-expanded below when the booking actually needs one of them.
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Tenant chargeback codes. When the tenant has configured any, a code is
  // required for every booking (the server re-checks against the same list).
  const customization = useTenant((s) => s.customization);
  const costCenters: string[] = Array.isArray(customization?.cost_centers) ? customization!.cost_centers : [];

  const ruleError = useMemo(() => validate({ date: bDate, start: bStart, end: bEnd }), [bDate, bStart, bEnd, validate]);

  const selected = useMemo(
    () => choices.find((r) => rId(r) === selResId),
    [choices, selResId]
  );

  // Free/busy: a room is "busy" if any non-cancelled booking overlaps the
  // chosen slot. We compare against the tenant-zone UTC instants (the same
  // conversion submit uses) so a traveller's browser zone can't skew it.
  const [slotStartMs, slotEndMs] = useMemo(() => {
    try {
      return [new Date(tz.toUtcIso(bDate, bStart)).getTime(), new Date(tz.toUtcIso(bDate, bEnd)).getTime()];
    } catch { return [NaN, NaN]; }
  }, [tz, bDate, bStart, bEnd]);

  const roomBusy = useMemo(() => {
    return (roomId: string) => {
      // Only meaningful for a valid forward slot; an inverted/zero slot is
      // caught by ruleError instead, so don't flag every room as busy.
      if (!(slotEndMs > slotStartMs)) return false;
      return (bookings || []).some((b) =>
        b.resourceId === roomId &&
        b.status !== 'Cancelled' &&
        // When editing, the booking occupies its own slot — don't let it flag
        // itself as a conflict.
        b.id !== existingBooking?.id &&
        new Date(b.startTime).getTime() < slotEndMs &&
        new Date(b.endTime).getTime() > slotStartMs);
    };
  }, [bookings, slotStartMs, slotEndMs, existingBooking]);

  // Scheduling-assistant data: the selected room's bookings on the chosen day,
  // as clamped minute-of-day intervals in the tenant zone, plus the day window
  // to render. Self is excluded in edit mode.
  const slotStartMin = hmToMin(bStart);
  const slotEndMin = hmToMin(bEnd);
  const dayBusy = useMemo(() => {
    if (!selResId || !bDate) return [] as { start: number; end: number; title: string }[];
    let dayStartMs: number;
    try { dayStartMs = new Date(tz.toUtcIso(bDate, '00:00')).getTime(); } catch { return []; }
    const dayEndMs = dayStartMs + 24 * 60 * 60000;
    return (bookings || [])
      .filter((b) => b.resourceId === selResId && b.status !== 'Cancelled' && b.id !== existingBooking?.id)
      .map((b) => ({ s: new Date(b.startTime).getTime(), e: new Date(b.endTime).getTime(), title: b.title || t('bookingModal.busy') }))
      .filter((b) => b.e > dayStartMs && b.s < dayEndMs)
      .map((b) => ({
        start: Math.max(0, Math.round((b.s - dayStartMs) / 60000)),
        end: Math.min(1440, Math.round((b.e - dayStartMs) / 60000)),
        title: b.title,
      }));
  }, [bookings, selResId, bDate, tz, existingBooking, t]);

  // Day window: a 7am–7pm baseline, widened to the hour to include any booking
  // or the proposed slot that falls outside it.
  const validSlot = slotEndMin > slotStartMin;
  const winStart = Math.max(0, Math.floor(Math.min(7 * 60, slotStartMin, ...dayBusy.map((b) => b.start)) / 60) * 60);
  const winEndRaw = Math.ceil(Math.max(19 * 60, slotEndMin, ...dayBusy.map((b) => b.end)) / 60) * 60;
  const winEnd = Math.min(1440, Math.max(winEndRaw, winStart + 60));

  // The currently-selected room conflicting with the (possibly edited) slot —
  // pre-empts the backend 409 before the user fills out the whole form.
  const selectedBusy = !!selResId && roomBusy(selResId);

  // Recurrence conflict preview (Outlook-style): expand the series client-side
  // and flag which occurrences land on a slot the chosen room is already booked
  // for. The backend still skips/handles conflicts on submit — this only warns
  // the user up front ("free for 3 of 4 dates") so they can adjust first.
  const recurPreview = useMemo(() => {
    if (!recur || !selResId) return [] as { date: string; conflict: boolean }[];
    const dates: string[] = [];
    const cap = 100;
    for (let i = 0; i < cap; i++) {
      const ds = occurrenceDate(bDate, pattern, i);
      if (until) { if (ds > until) break; } else if (i >= count) break;
      dates.push(ds);
    }
    return dates.map((ds) => {
      let sMs: number, eMs: number;
      try { sMs = new Date(tz.toUtcIso(ds, bStart)).getTime(); eMs = new Date(tz.toUtcIso(ds, bEnd)).getTime(); }
      catch { return { date: ds, conflict: false }; }
      if (!(eMs > sMs)) return { date: ds, conflict: false };
      const conflict = (bookings || []).some((b) =>
        b.resourceId === selResId &&
        b.status !== 'Cancelled' &&
        new Date(b.startTime).getTime() < eMs &&
        new Date(b.endTime).getTime() > sMs);
      return { date: ds, conflict };
    });
  }, [recur, selResId, bDate, pattern, count, until, tz, bStart, bEnd, bookings]);
  const recurConflicts = recurPreview.filter((o) => o.conflict).length;

  const resName  = selected ? rName(selected) : '';
  const resLoc   = selected ? (selected.location || selected.Location || '') : '';
  const resCap   = selected ? (selected.capacity || selected.Capacity || 0) : 0;
  const resId    = selResId;
  const needsApproval = !!(selected && (selected.requiresApproval ?? selected.RequiresApproval));
  // Room picker shows when there's a choice to make — including edit mode, since
  // a booking can now be moved to another room (resourceId on UpdateBookingDto).
  const showPicker = choices.length > 1 || !resource;

  // Custom booking-form fields are defined per resource. Answers are KEPT across
  // a room switch (keyed by field key) so a conflict-and-retry pre-fills the new
  // room's matching fields instead of wiping the form (QA enterprise #4); the
  // modal only renders/submits the keys the chosen room actually defines, so
  // stray answers from a previous room are harmless and never sent.
  const customFields = selected?.customFields || [];
  // Open the add-ons section automatically when the chosen room makes one of its
  // fields mandatory (a required cost center or custom field), or when editing a
  // booking that already carries services — so nothing required is ever hidden.
  const hasRequiredExtras = costCenters.length > 0 || customFields.some((f) => f.required);
  useEffect(() => {
    if (hasRequiredExtras || (isEdit && services.length > 0)) setShowAdvanced(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRequiredExtras]);
  useEffect(() => {
    // Apply the new room's default chargeback code only when the user hasn't
    // already chosen a (still-valid) one — don't clobber a draft selection.
    setCostCenter((cc) => {
      if (cc && costCenters.includes(cc)) return cc;
      const def = (selected as any)?.costCenterCode || '';
      return def && costCenters.includes(def) ? def : '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selResId]);
  function setCf(key: string, value: any) { setCfValues((m) => ({ ...m, [key]: value })); clearError(key); }

  // Persist the draft content on every change so it survives the modal
  // unmounting (close/reopen on another room). Create mode only — edit mode
  // operates on an existing booking and must not pollute the new-booking draft.
  useEffect(() => {
    if (isEdit) return;
    useBookingDraft.getState().save({
      title, meetingUrl, isPrivate, recur, pattern, count, until, services, costCenter, cfValues,
    });
  }, [isEdit, title, meetingUrl, isPrivate, recur, pattern, count, until, services, costCenter, cfValues]);

  // Pre-defined service add-ons — admins can override these via the
  // tenant studio later; for now this matches v1's hard-coded list.
  const SERVICE_OPTIONS = ['Catering', 'IT setup', 'AV equipment', 'Whiteboard'];

  function toggleService(opt: string) {
    setServices((arr) => (arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt]));
  }

  // Teams parity: cancellation lives inside the details dialog (a button in the
  // footer), not as an immediate prompt on calendar click. Asks for a reason
  // (audit-logged server-side) then closes.
  async function cancelExisting() {
    const cancelSeries = isRecurringInstance && editScope === 'series';
    const reason = await promptDialog({
      title: cancelSeries ? t('bookingModal.cancelSeriesBtn') : t('bookingModal.cancelBookingBtn'),
      message: cancelSeries
        ? t('bookingModal.cancelSeriesConfirm')
        : t('bookingModal.cancelConfirm', { title: existingBooking?.title || title || '' }),
      inputLabel: t('bookingModal.cancelReasonLabel'),
      placeholder: t('bookingModal.cancelReasonPlaceholder'),
      required: true,
      multiline: true,
      confirmText: cancelSeries ? t('bookingModal.cancelSeriesBtn') : t('bookingModal.cancelBookingBtn'),
      cancelText: t('bookingModal.keepBooking'),
      tone: 'danger',
    });
    if (!reason) return;
    setBusy(true);
    try {
      if (cancelSeries) {
        await api.cancelRecurringSeries(existingBooking.recurrenceId, reason);
      } else {
        await api.cancelBooking(existingBooking.id, reason);
      }
      toast.success(t('bookingModal.cancelled'));
      onBooked?.(existingBooking);
      onClose();
    } catch (e: any) {
      toast.error(t('bookingModal.cancelFailed'), e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  async function submit() {
    if (ruleError) { toast.error(t('bookingModal.cannotBook'), ruleError); return; }
    if (!resId) { toast.warning(t('bookingModal.pickResource')); return; }
    if (selectedBusy) { toast.error(t('bookingModal.cannotBook'), t('bookingModal.roomBusyConflict', { room: resName })); return; }

    // Title is optional: a blank title auto-generates "[Requester] - [Room]"
    // (e.g. "Johnny Poon - Boardroom A") for a cleaner calendar, instead of the
    // old generic "Booking". Falls back gracefully if either part is unknown.
    const finalTitle = title.trim()
      || [authUser?.username, resName].filter(Boolean).join(' - ')
      || t('booking.untitled', { defaultValue: 'Booking' });

    // --- Edit: only the fields UpdateBookingDto accepts (plus resourceId, so a
    // booking can be moved to another room). Close on success (no two-step
    // result panel — a Teams "Save" just applies and dismisses).
    if (isEdit) {
      const payload = {
        startTime: tz.toUtcIso(bDate, bStart),
        endTime: tz.toUtcIso(bDate, bEnd),
        title: finalTitle,
        meetingUrl: meetingUrl.trim(),
        // Service add-ons are editable post-creation now — send the current
        // selection (an empty array clears them server-side).
        services,
        // Only send the room when it actually changed, so an unchanged edit
        // doesn't pointlessly re-run the room conflict/approval path.
        ...(selResId !== existingBooking.resourceId ? { resourceId: selResId } : {}),
      };
      const applySeries = isRecurringInstance && editScope === 'series';
      setBusy(true);
      try {
        if (applySeries) {
          const r = await api.updateBookingSeries(existingBooking.id, payload);
          // Series edits are best-effort per occurrence: surface how many moved
          // and how many were skipped for a clash, like the create path.
          if (r?.skipped?.length) {
            toast.warning(
              t('bookingModal.seriesUpdated', { count: r.updated ?? 0 }),
              t('bookingModal.seriesUpdateSkipped', { count: r.skipped.length }),
            );
          } else {
            toast.success(t('bookingModal.seriesUpdated', { count: r?.updated ?? 0 }));
          }
        } else {
          await api.updateBooking(existingBooking.id, payload);
          toast.success(t('bookingModal.updated'));
        }
        onBooked?.(existingBooking);
        onClose();
      } catch (e: any) {
        toast.error(t('bookingModal.updateFailed'), e.displayMessage || e.message);
      } finally { setBusy(false); }
      return;
    }

    // Enforce required fields client-side (the server re-checks). Collect every
    // missing field so the user sees all of them inline at once, rather than
    // fixing one, re-submitting, and discovering the next.
    const errs: Record<string, string> = {};
    const requiredMsg = t('bookingModal.fieldRequired', { defaultValue: 'This field is required' });
    for (const f of customFields) {
      if (!f.required) continue;
      const v = cfValues[f.key];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) errs[f.key] = requiredMsg;
    }
    if (costCenters.length && !costCenter) errs.costCenter = requiredMsg;
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      setShowAdvanced(true); // the offending fields live in the add-ons section
      // Bring the first offending control into view (the modal body scrolls).
      // Deferred so the just-expanded add-ons section is in the DOM first.
      const firstKey = customFields.find((f) => errs[f.key])?.key ?? (errs.costCenter ? 'costCenter' : '');
      if (firstKey) setTimeout(() => document.getElementById(`bm-field-${firstKey}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
      return;
    }
    setFieldErrors({});
    // Only submit answers for fields the chosen room actually defines — the
    // draft may still hold answers from a previous room we switched away from.
    const definedKeys = new Set(customFields.map((f) => f.key));
    const scopedCf = Object.fromEntries(
      Object.entries(cfValues).filter(([k]) => definedKeys.has(k)),
    );
    const customFieldValues = Object.keys(scopedCf).length ? scopedCf : undefined;
    setBusy(true);
    try {
      // Lock the wall-clock slot to the tenant zone (not the browser's) so a
      // traveller doesn't silently book a different instant than the labelled
      // "times shown in <zone>" (QA #1).
      const startIso = tz.toUtcIso(bDate, bStart);
      const endIso = tz.toUtcIso(bDate, bEnd);
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
          title: finalTitle,
          meetingUrl: meetingUrl.trim() || undefined,
          isPrivate,
          customFieldValues,
          // Service add-ons must ride along with the series too — omitting them
          // here silently dropped catering/IT setup on every recurring booking.
          services: services.length ? services : undefined,
          costCenterCode: costCenter || undefined,
        });
      } else {
        r = await api.createBooking({
          resourceId: resId,
          startTime: startIso,
          endTime: endIso,
          title: finalTitle,
          meetingUrl: meetingUrl.trim() || undefined,
          isPrivate,
          services: services.length ? services : undefined,
          customFieldValues,
          costCenterCode: costCenter || undefined,
        });
      }
      // Booking committed — drop the saved draft so the next new booking starts
      // clean (it only existed to survive a conflict-and-retry).
      useBookingDraft.getState().clear();
      setResult(r || { status: 'Confirmed' });
      // Name the approver in the toast too (single-booking path), so the info
      // is visible even if the user dismisses the result panel quickly.
      const fa = r?.firstApprover as { role?: string; levelName?: string; names?: string[] } | undefined;
      const approverLabel = fa ? (fa.names?.length ? fa.names.join(', ') : (fa.role || fa.levelName || '')) : '';
      if (!recur && r?.requiresApproval && approverLabel) {
        toast.success(
          t('bookingModal.submitted'),
          t('bookingModal.waitingOnApprover', { approver: approverLabel, defaultValue: `Waiting on approval from ${approverLabel}` }),
        );
      } else {
        toast.success(recur ? t('bookingModal.recurringSubmitted') : t('bookingModal.submitted'));
      }
      // Leave the confirmation on screen; the footer swaps to a "Done" button
      // so the user reads the result and dismisses it themselves (QA #2).
    } catch (e: any) {
      toast.error(t('bookingModal.bookingFailed'), e.displayMessage || e.message);
    } finally { setBusy(false); }
  }

  return (
    <Modal
      title={isEdit ? t('bookingModal.editTitle') : t('bookingModal.confirmTitle')}
      onClose={onClose}
      footer={result ? <>
        <span className="spacer" />
        <button className="btn primary" onClick={() => { onBooked?.(result); onClose(); }}>
          {t('bookingModal.done')}
        </button>
      </> : <>
        {isEdit && (
          <button className="btn danger" disabled={busy} onClick={cancelExisting}>
            <Trash2 size={14} /> {isRecurringInstance && editScope === 'series'
              ? t('bookingModal.cancelSeriesBtn')
              : t('bookingModal.cancelBookingBtn')}
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost" onClick={onClose}>{isEdit ? t('common.close') : t('common.cancel')}</button>
        <button className="btn primary" disabled={busy || !!ruleError || !resId || selectedBusy} onClick={submit}>
          {busy && <Loader2 size={14} className="spin" />} {isEdit ? t('bookingModal.saveChanges') : t('bookingModal.confirm')}
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
                {choices.map((r) => {
                  // Room Finder-style: rooms already booked for this slot are
                  // disabled and tagged "Busy" so they can't be chosen blind.
                  const busy = roomBusy(rId(r));
                  return (
                    <option key={rId(r)} value={rId(r)} disabled={busy}>
                      {rName(r)}{(r.location || r.Location) ? ` · ${r.location || r.Location}` : ''}
                      {busy ? ` · ${t('bookingModal.busy')}` : ''}
                    </option>
                  );
                })}
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

      {/* Recurring-series scope (Outlook/Teams "this event vs entire series").
          Drives both the save (updateBookingSeries) and the cancel path. */}
      {isRecurringInstance && (
        <div className="field bm-box">
          <div className="row gap" style={{ alignItems: 'center' }}>
            <Repeat size={13} />
            <span className="text-sm">{t('bookingModal.editScopeLabel')}</span>
          </div>
          <div className="seg mt" role="radiogroup" aria-label={t('bookingModal.editScopeLabel')}>
            <button type="button" className={`seg-btn${editScope === 'single' ? ' active' : ''}`}
                    role="radio" aria-checked={editScope === 'single'} onClick={() => setEditScope('single')}>
              {t('bookingModal.editScopeThis')}
            </button>
            <button type="button" className={`seg-btn${editScope === 'series' ? ' active' : ''}`}
                    role="radio" aria-checked={editScope === 'series'} onClick={() => setEditScope('series')}>
              {t('bookingModal.editScopeSeries')}
            </button>
          </div>
          {editScope === 'series' && (
            <small className="muted" style={{ display: 'block', marginTop: 6 }}>
              {t('bookingModal.editScopeSeriesHint')}
            </small>
          )}
        </div>
      )}

      <div className="bm-timerow bm-timerow-edit">
        <label className="bm-when" aria-label={t('bookingModal.dateLabel')}>
          <Calendar size={14} />
          <input type="date" value={bDate} onChange={(e) => setBDate(e.target.value)} />
        </label>
        <label className="bm-when">
          <Clock size={14} />
          <input type="time" step={300} value={bStart} aria-label={t('bookingModal.startLabel')}
                 onChange={(e) => setBStart(e.target.value)} />
          <span className="bm-dash">–</span>
          <input type="time" step={300} value={bEnd} aria-label={t('bookingModal.endLabel')}
                 onChange={(e) => setBEnd(e.target.value)} />
        </label>
        <span className={`tag ${needsApproval ? 'warning' : 'ok'}`}>
          {needsApproval ? t('bookingModal.requiresApproval') : t('bookingModal.autoApproved')}
        </span>
      </div>
      {/* Always state the zone the slot is in — these times are the tenant's
          local wall-clock, which may differ from the viewer's browser zone. */}
      <small className="muted" style={{ display: 'block', marginTop: -4 }}>
        {t('bookingModal.timesShownIn', { zone: tz.label })}
      </small>

      {/* Scheduling assistant — visual free/busy for the chosen room that day,
          so the open white space is obvious (Teams parity). */}
      {selResId && validSlot && (
        <div className="field bm-fb">
          <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: 0 }}>
            <span><CalendarClock size={13} /> {t('bookingModal.schedulingAssistant')}</span>
            <span className="bm-fb-legend">
              <i className="dot busy" />{t('bookingModal.busy')}
              <i className="dot slot" />{t('bookingModal.yourSlot')}
            </span>
          </label>
          <FreeBusyTimeline
            winStart={winStart} winEnd={winEnd} busy={dayBusy}
            slotStart={slotStartMin} slotEnd={slotEndMin} conflict={selectedBusy}
          />
          {dayBusy.length === 0 && (
            <small className="muted">{t('bookingModal.noBookingsThatDay', { room: resName })}</small>
          )}
        </div>
      )}

      <label>{t('bookingModal.fieldTitle')}
        <input value={title} onChange={(e) => setTitle(e.target.value)}
               placeholder={authUser?.username && resName
                 ? `${authUser.username} - ${resName}`
                 : t('bookingModal.titlePlaceholder')} />
        <small className="muted">{t('bookingModal.titleAutoHint', { defaultValue: 'Leave blank to auto-name it "[You] - [Room]".' })}</small>
      </label>

      <label>{t('bookingModal.meetingUrl')}
        <input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)}
               placeholder="https://teams.microsoft.com/…" />
      </label>

      <div className="bm-advanced">
        <button type="button" className="bm-advanced-toggle" aria-expanded={showAdvanced}
                onClick={() => setShowAdvanced((s) => !s)}>
          <SlidersHorizontal size={14} />
          <span className="bm-advanced-label">{t('bookingModal.advancedToggle', { defaultValue: 'Add-ons & details' })}</span>
          {hasRequiredExtras && <span className="bm-advanced-req">{t('bookingModal.advancedRequired', { defaultValue: 'Required' })}</span>}
          <ChevronRight size={16} className={`bm-advanced-chev${showAdvanced ? ' open' : ''}`} />
        </button>
        {showAdvanced && (
        <div className="bm-advanced-body">

      {!isEdit && costCenters.length > 0 && (
        <label id="bm-field-costCenter">Cost center*
          <Combobox
            className={fieldErrors.costCenter ? 'invalid' : undefined}
            ariaLabel="Cost center"
            value={costCenter}
            onChange={(v) => { setCostCenter(v); clearError('costCenter'); }}
            placeholder="Choose a cost center…"
            options={costCenters.map((cc) => ({ value: cc, label: cc }))}
          />
          {fieldErrors.costCenter && <small className="field-err">{fieldErrors.costCenter}</small>}
        </label>
      )}

      {/* Services render in both create and edit — add-ons can be changed after
          the booking is made (no cancel-and-rebook just to add Catering). */}
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
          enforced on submit (and again server-side). Create-only — update can't
          change them. */}
      {!isEdit && customFields.map((f) => {
        const label = `${f.label || f.key}${f.required ? '*' : ''}`;
        const err = fieldErrors[f.key];
        const errEl = err ? <small className="field-err">{err}</small> : null;
        if (f.type === 'checkbox') {
          return (
            <div key={f.key} id={`bm-field-${f.key}`}>
              <label className="row" style={{ alignItems: 'center', gap: 8 }}>
                <input type="checkbox" checked={!!cfValues[f.key]}
                       onChange={(e) => setCf(f.key, e.target.checked)} />
                <span>{label}</span>
              </label>
              {errEl}
            </div>
          );
        }
        if (f.type === 'select') {
          return (
            <label key={f.key} id={`bm-field-${f.key}`}>{label}
              <select value={cfValues[f.key] ?? ''} aria-invalid={!!err}
                      className={err ? 'invalid' : ''}
                      onChange={(e) => setCf(f.key, e.target.value)}>
                <option value="">{t('bookingModal.choose')}</option>
                {(f.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              {errEl}
            </label>
          );
        }
        return (
          <label key={f.key} id={`bm-field-${f.key}`}>{label}
            <input
              type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
              value={cfValues[f.key] ?? ''}
              aria-invalid={!!err}
              className={err ? 'invalid' : ''}
              onChange={(e) => setCf(f.key, f.type === 'number' ? (e.target.value === '' ? '' : +e.target.value) : e.target.value)}
            />
            {errEl}
          </label>
        );
      })}

        </div>
        )}
      </div>

      {!isEdit && (
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
        {recur && selResId && recurPreview.length > 0 && (
          <div className="mt">
            <small className={recurConflicts ? '' : 'muted'}
                   style={{ display: 'block', marginBottom: 6, color: recurConflicts ? '#d97706' : undefined, fontWeight: recurConflicts ? 600 : undefined }}>
              {recurConflicts
                ? t('bookingModal.recurAvailable', { room: resName, ok: recurPreview.length - recurConflicts, total: recurPreview.length })
                : t('bookingModal.recurAllClear', { room: resName, total: recurPreview.length })}
            </small>
            <div className="chip-grid">
              {recurPreview.map((o) => (
                <span key={o.date} className={`tag ${o.conflict ? 'warning' : 'ok'}`}
                      title={o.conflict ? t('bookingModal.roomBusyConflict', { room: resName }) : ''}>
                  {o.date}{o.conflict ? ' ⚠' : ''}
                </span>
              ))}
            </div>
            {recurConflicts > 0 && (
              <small className="muted" style={{ display: 'block', marginTop: 6 }}>
                {t('bookingModal.recurConflictHint')}
              </small>
            )}
          </div>
        )}
      </div>
      )}

      {!isEdit && (
        <div className="row gap mt" style={{ alignItems: 'center' }}>
          <Switch checked={isPrivate} onChange={setPrivate} label={t('bookingModal.private')} />
          <span><Lock size={13} /> {t('bookingModal.privateHint')}</span>
        </div>
      )}

      {result && (() => {
        // A recurring result carries bookingIds (materialised) + skipped (ISO
        // timestamps of occurrences the backend dropped to avoid a double-book).
        // Surface the skips explicitly (Outlook-style) instead of a blanket
        // "Confirmed", so the user knows e.g. week 5 didn't actually book.
        const skipped: string[] = Array.isArray(result.skipped) ? result.skipped : [];
        const created = Array.isArray(result.bookingIds) ? result.bookingIds.length : null;
        const total = created != null ? created + skipped.length : null;
        // requiresApproval comes back from the create response now (the old
        // snake_case `requires_approval` was never set, so this panel always
        // claimed "Confirmed" even for approval-gated rooms).
        const pending = !!result.requiresApproval;
        const fa = result.firstApprover as
          | { levelName?: string; role?: string; names?: string[] } | null | undefined;
        const approverLabel = fa
          ? (fa.names && fa.names.length ? fa.names.join(', ') : (fa.role || fa.levelName || ''))
          : '';
        const chain = Array.isArray(result.approvalChain) ? result.approvalChain : [];
        return (
          <div className={`bm-result mt${skipped.length ? ' warning' : ''}`}>
            <Check size={16} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{pending ? t('bookingModal.pendingApproval') : t('bookingModal.confirmed')}</b>
              <p className="muted small">
                {created != null
                  ? t('bookingModal.recurBooked', { ok: created, total })
                  : pending
                    ? t('bookingModal.pendingHint')
                    : t('bookingModal.confirmedHint')}
              </p>
              {/* "Who is my approver?" — name the first step the booking is
                  waiting on so the user knows who to chase (QA enterprise #4). */}
              {pending && approverLabel && (
                <p className="small" style={{ margin: '4px 0 0', fontWeight: 600 }}>
                  {t('bookingModal.waitingOnApprover', {
                    approver: approverLabel,
                    defaultValue: `Waiting on approval from ${approverLabel}`,
                  })}
                </p>
              )}
              {/* Surface the full chain immediately after booking so the
                  requester sees every step, not just a flat "Pending". */}
              {pending && chain.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <ApprovalTimeline steps={chain} submittedAt={result.createdAt} />
                </div>
              )}
              {skipped.length > 0 && (
                <p className="small" style={{ color: '#d97706', fontWeight: 600, margin: '4px 0 0' }}>
                  {t('bookingModal.recurSkipped', { count: skipped.length })}
                </p>
              )}
            </div>
          </div>
        );
      })()}

      {ruleError && <div className="err mt">{ruleError}</div>}
      {!ruleError && selectedBusy && (
        <div className="err mt">{t('bookingModal.roomBusyConflict', { room: resName })}</div>
      )}
    </Modal>
  );
}
