import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { useTimezone } from '../hooks/useTimezone';
import { useToast } from '../stores/toast';
import { weekdayOfDate } from '../utils/datetime';

// NewBooking is the multi-step booking wizard, separate from the
// drag-create flow on the calendar page. Three steps:
//   1) When/where — date, time, capacity, optional location filter
//   2) Pick a room — list of resources that are free at that slot
//   3) Details — title, optional meeting URL, and the "Make recurring"
//      toggle with pattern picker.
// Mirrors v1's NewBooking.vue flow.

type Step = 1 | 2 | 3;
type Pattern = 'daily' | 'weekly' | 'bi-weekly' | 'monthly';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function NewBooking() {
  const { t } = useT();
  const nav = useNavigate();
  const tz = useTimezone();
  const toast = useToast();
  // Local YYYY-MM-DD — NOT toISOString(), which is UTC and would roll the
  // default (and the min= floor) back a day for users east of GMT in the
  // early morning. en-CA formats local time as YYYY-MM-DD natively (QA #2).
  const today = new Date().toLocaleDateString('en-CA');

  // Step 1 inputs
  const [step, setStep] = useState<Step>(1);
  const [when, setWhen] = useState({
    date: today, startTime: '09:00', endTime: '10:00', capacity: 1, location: '',
  });

  // Step 2 — search results + selection
  const [rooms, setRooms] = useState<any[] | null>(null);
  const [pickedRoom, setPickedRoom] = useState<any | null>(null);
  const [searching, setSearching] = useState(false);

  // Step 3 — booking detail + optional recurrence
  const [detail, setDetail] = useState({ title: '', meetingUrl: '', isPrivate: false });
  // Resource-defined custom booking-form fields (e.g. Cost Center Code). The
  // room may require them, so the wizard must render and enforce them or the
  // server rejects the submit with a 400 (QA #1).
  const [cfValues, setCfValues] = useState<Record<string, any>>({});
  const [recurring, setRecurring] = useState(false);
  const [pattern, setPattern] = useState<Pattern>('weekly');
  const [interval, setInterval] = useState(1);
  const [count, setCount] = useState(4);
  const [until, setUntil] = useState('');
  const [byday, setByday] = useState<number[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ ok: string; warn?: string } | null>(null);

  // Pre-select the weekday from `when.date` once the user opens
  // weekly recurrence — convenient default, can still be edited.
  useEffect(() => {
    if (recurring && pattern === 'weekly' && byday.length === 0 && when.date) {
      setByday([weekdayOfDate(when.date)]);
    }
  }, [recurring, pattern, when.date, when.startTime]);

  // Build the ISO instants from the tenant-zone wall clock (not the browser's)
  // so a viewer in another timezone still books the slot they see (QA #1).
  const startIso = useMemo(
    () => tz.toUtcIso(when.date, when.startTime),
    [when.date, when.startTime, tz],
  );
  const endIso = useMemo(
    () => tz.toUtcIso(when.date, when.endTime),
    [when.date, when.endTime, tz],
  );

  async function search() {
    // Guard against an inverted window (e.g. 14:00 → 10:00) before firing the
    // search — otherwise the server is queried for a negative range and the
    // user gets a confusing empty result instead of a clear reason (QA #3).
    if (when.startTime >= when.endTime) {
      toast.error('End time must be after start time');
      return;
    }
    setSearching(true);
    try {
      const list = await api.searchResources(when);
      setRooms(list);
      setStep(2);
    } finally { setSearching(false); }
  }

  function pickRoom(r: any) {
    setPickedRoom(r);
    setCfValues({});   // a different room never inherits the previous one's answers
    setStep(3);
  }

  const customFields: any[] = pickedRoom?.customFields || [];
  function setCf(key: string, value: any) { setCfValues((m) => ({ ...m, [key]: value })); }

  function toggleByday(wd: number) {
    setByday((cur) => cur.includes(wd) ? cur.filter((d) => d !== wd) : [...cur, wd].sort());
  }

  // Reset the wizard to step 1 for a fresh booking, keeping the user on the
  // page after a success rather than auto-bouncing them away (QA #2).
  function bookAnother() {
    setResult(null);
    setPickedRoom(null);
    setRooms(null);
    setRecurring(false);
    setDetail({ title: '', meetingUrl: '', isPrivate: false });
    setCfValues({});
    setStep(1);
  }

  async function submit() {
    if (!pickedRoom) return;
    // Enforce required custom fields client-side (the server re-checks). Without
    // this the wizard would let the user submit a room that demands e.g. a Cost
    // Center Code and only surface the failure as a raw 400 (QA #1).
    for (const f of customFields) {
      if (!f.required) continue;
      const v = cfValues[f.key];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
      if (empty) { toast.warning(t('bookingModal.requiredField', { field: f.label || f.key })); return; }
    }
    const customFieldValues = Object.keys(cfValues).length ? cfValues : undefined;
    setSubmitting(true);
    setResult(null);
    try {
      if (!recurring) {
        const created = await api.createBooking({
          resourceId: pickedRoom.id,
          startTime: startIso,
          endTime: endIso,
          title: detail.title,
          meetingUrl: detail.meetingUrl,
          isPrivate: detail.isPrivate,
          customFieldValues,
        });
        setResult({ ok: t('booking.bookedId', { id: created.id }) });
      } else {
        const res = await api.createRecurringBooking({
          resourceId: pickedRoom.id,
          firstStart: startIso,
          firstEnd: endIso,
          pattern,
          interval,
          count: until ? undefined : count,
          until: until ? tz.toUtcIso(until, '23:59:59') : undefined,
          byday: pattern === 'weekly' ? byday : undefined,
          title: detail.title,
          meetingUrl: detail.meetingUrl,
          isPrivate: detail.isPrivate,
          customFieldValues,
        });
        const created = res.bookingIds?.length || 0;
        const skipped = res.skipped?.length || 0;
        setResult({
          ok: t('booking.seriesCreated', { count: created }),
          warn: skipped ? t('booking.occurrencesSkipped', { count: skipped }) : undefined,
        });
      }
      // Success stays on screen with explicit next-step buttons (below) — no
      // auto-redirect, so the confirmation is readable and the user, not a
      // timer, decides when to move on (QA #2).
    } catch (e: any) {
      setResult({ ok: '', warn: e.displayMessage || t('booking.bookingFailed') });
    } finally { setSubmitting(false); }
  }

  return (
    <div>
      <h1 className="fsd-page-title">{t('booking.newBooking')}</h1>
      <div className="muted" style={{ marginBottom: 12 }}>
        {t('booking.stepOf', { step })} — {step === 1 ? t('booking.stepWhenWhere') : step === 2 ? t('booking.stepPickRoom') : t('booking.stepDetails')}
      </div>

      {/* ---- Step 1: when & where ---- */}
      {step === 1 && (
        <div className="card searchbar">
          <label>{t('search.date')} <input type="date" value={when.date} min={today}
            onChange={(e) => setWhen({ ...when, date: e.target.value })} /></label>
          <label>{t('booking.from')} <input type="time" value={when.startTime}
            onChange={(e) => setWhen({ ...when, startTime: e.target.value })} /></label>
          <label>{t('booking.to')} <input type="time" value={when.endTime}
            onChange={(e) => setWhen({ ...when, endTime: e.target.value })} /></label>
          <label>{t('common.capacity')} <input type="number" min={1} value={when.capacity}
            onChange={(e) => setWhen({ ...when, capacity: +e.target.value })} /></label>
          <label>{t('booking.location')} <input placeholder="optional" value={when.location}
            onChange={(e) => setWhen({ ...when, location: e.target.value })} /></label>
          <button className="btn primary" disabled={searching} onClick={search}>
            {searching ? t('booking.searching') : t('booking.findRooms')}
          </button>
          <small className="muted" style={{ flexBasis: '100%' }}>
            Times shown in {tz.label}
          </small>
        </div>
      )}

      {/* ---- Step 2: pick a room ---- */}
      {step === 2 && (
        <>
          <button className="btn" onClick={() => setStep(1)}>← {t('booking.back')}</button>
          {rooms && rooms.length === 0 && <p className="muted">{t('booking.noRoomsSlot')}</p>}
          <ul className="result-list">
            {rooms?.map((r) => (
              <li key={r.id} className="card row">
                <div className="space">
                  <b>{r.name}</b>{' '}
                  <span className="muted">· {r.location || '—'} · {r.capacity || '–'} {t('booking.pax')}</span>
                </div>
                <button className="btn primary" onClick={() => pickRoom(r)}>{t('booking.choose')}</button>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ---- Step 3: details + recurrence ---- */}
      {step === 3 && pickedRoom && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 240px', gap: 16, alignItems: 'start' }}>
        <div className="card" style={{ display: 'grid', gap: 12 }}>
          <button className="btn" onClick={() => setStep(2)} style={{ justifySelf: 'start' }}>← {t('booking.back')}</button>
          <div><b>{pickedRoom.name}</b> <span className="muted">· {when.date} {when.startTime}–{when.endTime}</span></div>

          <label>{t('booking.title')} <input value={detail.title}
            onChange={(e) => setDetail({ ...detail, title: e.target.value })} /></label>
          <label>{t('booking.meetingURL')} <input placeholder="https://…" value={detail.meetingUrl}
            onChange={(e) => setDetail({ ...detail, meetingUrl: e.target.value })} /></label>
          <label>
            <input type="checkbox" checked={detail.isPrivate}
              onChange={(e) => setDetail({ ...detail, isPrivate: e.target.checked })} />
            {' '}{t('booking.privateHideTitle')}
          </label>

          {/* Resource-defined custom fields — rendered by type; required ones
              are enforced on submit (and again server-side) (QA #1). */}
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
                    {(f.options || []).map((o: string) => <option key={o} value={o}>{o}</option>)}
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

          <hr />

          <label>
            <input type="checkbox" checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)} />
            {' '}<b>{t('booking.makeRecurring')}</b>
          </label>

          {recurring && (
            <div style={{ display: 'grid', gap: 8, padding: 8, background: '#f7f7fa', borderRadius: 6 }}>
              <label>{t('booking.pattern')}{' '}
                <select value={pattern} onChange={(e) => setPattern(e.target.value as Pattern)}>
                  <option value="daily">{t('booking.daily')}</option>
                  <option value="weekly">{t('booking.weekly')}</option>
                  <option value="bi-weekly">{t('booking.biweekly')}</option>
                  <option value="monthly">{t('booking.monthly')}</option>
                </select>
              </label>
              <label>{t('booking.every')}{' '}
                <input type="number" min={1} max={12} value={interval}
                  onChange={(e) => setInterval(+e.target.value)} />
                {' '}{pattern === 'daily' ? t('booking.unitDays') : pattern === 'weekly' ? t('booking.unitWeeks') :
                      pattern === 'bi-weekly' ? t('booking.unitBiweekly') : t('booking.unitMonths')}
              </label>

              {pattern === 'weekly' && (
                <div>{t('booking.on')}{' '}
                  {WEEKDAYS.map((w, i) => (
                    <label key={w} style={{ marginRight: 8 }}>
                      <input type="checkbox" checked={byday.includes(i)}
                        onChange={() => toggleByday(i)} /> {t(`booking.weekdayShort.${i}`)}
                    </label>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <label>{t('booking.count')} <input type="number" min={1} max={100} value={count}
                  onChange={(e) => setCount(+e.target.value)} disabled={!!until} /></label>
                <span className="muted">{t('booking.or')}</span>
                <label>{t('booking.until')} <input type="date" value={until} min={when.date}
                  onChange={(e) => setUntil(e.target.value)} /></label>
              </div>
              <small className="muted">{t('booking.seriesCapHelp')}</small>
            </div>
          )}

          {!result?.ok && (
            <button className="btn primary" disabled={submitting} onClick={submit}>
              {submitting ? t('common.saving') : recurring ? t('booking.createSeries') : t('booking.confirm')}
            </button>
          )}

          {result?.ok && <div className="alert success">{result.ok}</div>}
          {result?.warn && <div className="alert warn">{result.warn}</div>}

          {result?.ok && (
            <div className="row gap" style={{ flexWrap: 'wrap' }}>
              <button className="btn primary" onClick={() => nav('/my')}>{t('booking.viewMyBookings')}</button>
              <button className="btn" onClick={bookAnother}>{t('booking.bookAnother')}</button>
            </div>
          )}
        </div>

        {/* Room Detail panel — mirrors v1's NewBooking.vue side panel. */}
        <aside className="card room-detail">
          <h3 style={{ marginTop: 0 }}>{t('booking.roomDetail')}</h3>
          <dl className="kv">
            <dt>{t('booking.name')}</dt><dd>{pickedRoom.name}</dd>
            <dt>{t('booking.location')}</dt><dd>{pickedRoom.location || '—'}</dd>
            <dt>{t('booking.seats')}</dt><dd>{pickedRoom.capacity || '—'}</dd>
            <dt>{t('booking.assetType')}</dt><dd>{pickedRoom.assetType || t('booking.meetingRoom')}</dd>
            <dt>{t('booking.approval')}</dt><dd>{pickedRoom.requiresApproval ? t('booking.required') : t('booking.autoApproved')}</dd>
          </dl>
        </aside>
        </div>
      )}
    </div>
  );
}
