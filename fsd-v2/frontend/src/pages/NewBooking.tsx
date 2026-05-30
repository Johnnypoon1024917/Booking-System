import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useT } from '../hooks/useT';
import { useTimezone } from '../hooks/useTimezone';

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
  const today = new Date().toISOString().slice(0, 10);

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
    if (recurring && pattern === 'weekly' && byday.length === 0) {
      const d = new Date(`${when.date}T${when.startTime}:00`);
      if (!isNaN(+d)) setByday([d.getDay()]);
    }
  }, [recurring, pattern, when.date, when.startTime]);

  const startIso = useMemo(
    () => new Date(`${when.date}T${when.startTime}:00`).toISOString(),
    [when.date, when.startTime],
  );
  const endIso = useMemo(
    () => new Date(`${when.date}T${when.endTime}:00`).toISOString(),
    [when.date, when.endTime],
  );

  async function search() {
    setSearching(true);
    try {
      const list = await api.searchResources(when);
      setRooms(list);
      setStep(2);
    } finally { setSearching(false); }
  }

  function pickRoom(r: any) {
    setPickedRoom(r);
    setStep(3);
  }

  function toggleByday(wd: number) {
    setByday((cur) => cur.includes(wd) ? cur.filter((d) => d !== wd) : [...cur, wd].sort());
  }

  async function submit() {
    if (!pickedRoom) return;
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
          until: until ? new Date(`${until}T23:59:59`).toISOString() : undefined,
          byday: pattern === 'weekly' ? byday : undefined,
          title: detail.title,
          meetingUrl: detail.meetingUrl,
          isPrivate: detail.isPrivate,
        });
        const created = res.bookingIds?.length || 0;
        const skipped = res.skipped?.length || 0;
        setResult({
          ok: t('booking.seriesCreated', { count: created }),
          warn: skipped ? t('booking.occurrencesSkipped', { count: skipped }) : undefined,
        });
      }
      // Hop to My Bookings after a short pause so the user can see the toast.
      setTimeout(() => nav('/my'), 1500);
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
                <label>{t('booking.until')} <input type="date" value={until}
                  onChange={(e) => setUntil(e.target.value)} /></label>
              </div>
              <small className="muted">{t('booking.seriesCapHelp')}</small>
            </div>
          )}

          <button className="btn primary" disabled={submitting} onClick={submit}>
            {submitting ? t('common.saving') : recurring ? t('booking.createSeries') : t('booking.confirm')}
          </button>

          {result?.ok && <div className="alert success">{result.ok}</div>}
          {result?.warn && <div className="alert warn">{result.warn}</div>}
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
