import { useEffect, useMemo, useState } from 'react';
import { Search as SearchIcon, SearchX, MapPinned, Check, X } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useTenant } from '../stores/tenant';
import { useBookingRules } from '../hooks/useBookingRules';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { BookingModal } from '../components/BookingModal';

// Direct port of v1's Search.vue: two-panel shell (filters | availability),
// location dropdown, all-day toggle, 30-min time-slot pickers honouring the
// tenant working hours, recurring-pattern setup with end-date validation,
// split-room aware result list (parent rooms followed by indented sub-rooms
// with cross-lock "blocked via" indicators), and the BookingModal confirm
// flow. The "next available slots" suggestion strip from v1 is omitted —
// v2 has no slot-suggestion endpoint yet.
const STEP = 30;

function initialStart() {
  const d = new Date();
  d.setMinutes(d.getMinutes() + ((30 - (d.getMinutes() % 30)) % 30), 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function addMinutes(hhmm: string, mins: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

type CellKind = 'ok' | 'blocked' | 'unavailable';
interface Row { id: string; r: any; depth: number; st: { kind: CellKind; via?: string }; }

export function Search() {
  const toast = useToast();
  const tenant = useTenant((s) => s.customization);
  const { allowsPattern } = useBookingRules();

  const today = new Date().toISOString().slice(0, 10);
  const start0 = initialStart();
  const [form, setForm] = useState({
    region: '', date: today, capacity: 4,
    start: start0, end: addMinutes(start0, 60),
    allDay: false, recur: false, pattern: 'daily', endDate: '',
  });
  function set<K extends keyof typeof form>(k: K, v: any) { setForm((f) => ({ ...f, [k]: v })); }

  const [allResources, setAllResources] = useState<any[]>([]);
  const [available, setAvailable] = useState<any[]>([]);
  const [unavailable, setUnavailable] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [picked, setPicked] = useState<any | null>(null);
  const [modalRoom, setModalRoom] = useState<any | null>(null);

  // 30-min time slots inside the admin-configured working hours; slots
  // earlier than "now" are disabled when the chosen date is today.
  const timeSlots = useMemo(() => {
    const c: any = tenant || {};
    const sh = Number.isInteger(c.calendar_start_hour) ? c.calendar_start_hour
      : Number.isInteger(c.calendarStartHour) ? c.calendarStartHour : 8;
    const eh = Number.isInteger(c.calendar_end_hour) ? c.calendar_end_hour
      : Number.isInteger(c.calendarEndHour) ? c.calendarEndHour : 20;
    const isToday = form.date === new Date().toISOString().slice(0, 10);
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    const out: { value: string; past: boolean }[] = [];
    for (let m = sh * 60; m <= eh * 60; m += STEP) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      out.push({ value: `${hh}:${mm}`, past: isToday && m < nowMin });
    }
    return out;
  }, [tenant, form.date]);

  const locations = useMemo(() => {
    const ls = [...new Set(allResources.map((r) => r.location).filter(Boolean))];
    return ls.length ? ls : ['Hong Kong'];
  }, [allResources]);

  // --- Split-room awareness (parent/child grouping + cross-lock) ---
  const childrenOf = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const r of allResources) {
      if (r.parentResourceId) (m[r.parentResourceId] = m[r.parentResourceId] || []).push(r.id);
    }
    return m;
  }, [allResources]);
  const resById = useMemo(() => Object.fromEntries(allResources.map((r) => [r.id, r])), [allResources]);
  const isParent = (r: any) => r.compositeMode === 'parent';
  const isChild = (r: any) => r.compositeMode === 'child';
  function relatedIds(r: any): string[] {
    const out: string[] = [];
    if (isChild(r) && r.parentResourceId) out.push(r.parentResourceId);
    if (isParent(r)) out.push(...(childrenOf[r.id] || []));
    return out;
  }

  const rows = useMemo<Row[]>(() => {
    const availIds = new Set(available.map((r) => r.id));
    const unavailIds = new Set(unavailable.map((r) => r.id));
    const stateOf = (r: any): { kind: CellKind; via?: string } => {
      if (!availIds.has(r.id)) return { kind: 'unavailable' };
      for (const rid of relatedIds(r)) {
        if (unavailIds.has(rid)) return { kind: 'blocked', via: resById[rid]?.name || 'a linked space' };
      }
      return { kind: 'ok' };
    };
    const seen = new Set<string>();
    const uniq: any[] = [];
    for (const r of [...available, ...unavailable]) {
      if (!seen.has(r.id)) { seen.add(r.id); uniq.push(r); }
    }
    const byId = Object.fromEntries(uniq.map((r) => [r.id, r]));
    const out: Row[] = [];
    const placed = new Set<string>();
    for (const r of uniq) {
      if (!isParent(r)) continue;
      out.push({ id: r.id, r, depth: 0, st: stateOf(r) }); placed.add(r.id);
      for (const cid of (childrenOf[r.id] || [])) {
        if (byId[cid]) { out.push({ id: cid, r: byId[cid], depth: 1, st: stateOf(byId[cid]) }); placed.add(cid); }
      }
    }
    for (const r of uniq) {
      if (placed.has(r.id) || isParent(r)) continue;
      out.push({ id: r.id, r, depth: 0, st: stateOf(r) });
    }
    return out;
  }, [available, unavailable, childrenOf, resById]);

  // A repeating reservation must have a termination date (FSD §3.2).
  const recurError = useMemo(() => {
    if (!form.recur) return '';
    if (!form.endDate) return 'A repeating schedule requires an end date.';
    if (form.endDate < form.date) return 'End date must be on or after the booking date.';
    return '';
  }, [form.recur, form.endDate, form.date]);

  useEffect(() => {
    (async () => {
      try {
        const list = await api.resources().catch(() => []);
        setAllResources(list || []);
        const locs = [...new Set((list || []).map((r: any) => r.location).filter(Boolean))];
        setForm((f) => ({ ...f, region: (locs[0] as string) || 'Hong Kong' }));
      } catch { /* non-fatal */ }
    })();
  }, []);

  async function search() {
    setBusy(true); setHasSearched(true); setPicked(null);
    const query = {
      location: form.region, date: form.date,
      startTime: form.allDay ? '00:00' : form.start,
      endTime: form.allDay ? '23:59' : form.end,
      capacity: form.capacity,
    };
    try {
      const data = await api.searchResources(query);
      const list = Array.isArray(data) ? data : [];
      const availIds = new Set(list.map((r: any) => r.id));
      setAvailable(list);
      setUnavailable(allResources.filter((r) =>
        r.location === form.region && (r.capacity || 0) >= form.capacity && !availIds.has(r.id)));
    } catch (e: any) {
      toast.error('Search failed', e.displayMessage || e.message);
      setAvailable([]); setUnavailable([]);
    } finally { setBusy(false); }
  }

  function syncEnd(v: string) {
    set('start', v);
    if (form.end <= v) set('end', addMinutes(v, 60));
  }
  function onBooked() { setModalRoom(null); setPicked(null); toast.success('Reservation submitted'); search(); }

  const anyOk = rows.some((x) => x.st.kind === 'ok');

  return (
    <div className="mrbs">
      <h1 className="fsd-page-title">New Booking</h1>

      <div className="search-shell">
        {/* Filters */}
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="ph"><span>Search Room</span></div>
          <form className="pb" onSubmit={(e) => { e.preventDefault(); search(); }}>
            <label className="fld">
              <span>Location</span>
              <select value={form.region} onChange={(e) => set('region', e.target.value)}>
                {locations.map((loc) => <option key={loc} value={loc}>{loc}</option>)}
              </select>
            </label>

            <label className="fld">
              <span>Date</span>
              <input type="date" value={form.date} onChange={(e) => set('date', e.target.value)}/>
            </label>

            <label className="cbx mb"><input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)}/> All Day Event</label>

            {!form.allDay && (
              <div className="grid-2">
                <label className="fld">
                  <span>Start Time</span>
                  <select value={form.start} onChange={(e) => syncEnd(e.target.value)}>
                    {timeSlots.map((t) => <option key={'s' + t.value} value={t.value} disabled={t.past}>{t.value}{t.past ? ' (past)' : ''}</option>)}
                  </select>
                </label>
                <label className="fld">
                  <span>End Time</span>
                  <select value={form.end} onChange={(e) => set('end', e.target.value)}>
                    {timeSlots.map((t) => <option key={'e' + t.value} value={t.value} disabled={t.past || t.value <= form.start}>{t.value}</option>)}
                  </select>
                </label>
              </div>
            )}

            <label className="fld">
              <span>Capacity</span>
              <input type="number" min={1} value={form.capacity} onChange={(e) => set('capacity', +e.target.value)}/>
            </label>

            <label className="cbx mb"><input type="checkbox" checked={form.recur} onChange={(e) => set('recur', e.target.checked)}/> Enable Repeating Schedule Pattern</label>

            {form.recur && (
              <div className="recur-box mb">
                <div className="ph2">Recurring Pattern Setup</div>
                <div className="rb">
                  <div className="row gap mb" style={{ flexWrap: 'wrap' }}>
                    {allowsPattern('daily') && <label className="rad"><input type="radio" name="pat" value="daily" checked={form.pattern === 'daily'} onChange={() => set('pattern', 'daily')}/> Daily</label>}
                    {allowsPattern('weekly') && <label className="rad"><input type="radio" name="pat" value="weekly" checked={form.pattern === 'weekly'} onChange={() => set('pattern', 'weekly')}/> Weekly</label>}
                    {allowsPattern('monthly') && <label className="rad"><input type="radio" name="pat" value="monthly" checked={form.pattern === 'monthly'} onChange={() => set('pattern', 'monthly')}/> Monthly</label>}
                    {allowsPattern('weekday') && <label className="rad"><input type="radio" name="pat" value="weekday" checked={form.pattern === 'weekday'} onChange={() => set('pattern', 'weekday')}/> Weekdays</label>}
                  </div>
                  <label className="fld" style={{ margin: 0 }}>
                    <span>End By Date (required)</span>
                    <input type="date" value={form.endDate} min={form.date} onChange={(e) => set('endDate', e.target.value)}/>
                  </label>
                  {recurError && <p className="check-msg bad" style={{ marginTop: 6 }}>{recurError}</p>}
                </div>
              </div>
            )}

            <button className="mrbs-btn" style={{ width: '100%', justifyContent: 'center' }} disabled={busy}>
              <SearchIcon size={15}/> {busy ? 'Searching…' : 'Search'}
            </button>
          </form>
        </div>

        {/* Results */}
        <div className="panel" style={{ alignSelf: 'start' }}>
          <div className="ph">
            <span>Room Availability</span>
            {hasSearched && <span className="rng">{form.date} · {form.allDay ? 'All Day' : `${form.start}–${form.end}`}</span>}
          </div>
          <div className="pb">
            {busy && <Skeleton height="220px"/>}

            {!busy && hasSearched && (
              <>
                {anyOk && (
                  <div className="avail-note"><Check size={13}/> The following rooms are available. Split spaces show their sub-rooms indented.</div>
                )}
                <div className="avail-list">
                  {rows.map((row) => (
                    <div key={row.id}
                         className={`avail-row ${row.st.kind === 'ok' ? 'ok' : 'bad'}`}
                         style={{ paddingLeft: 12 + row.depth * 22 }}
                         title={row.st.kind === 'blocked' ? `Blocked by a booking on ${row.st.via} (shared/split space)` : ''}
                         onClick={() => row.st.kind === 'ok' && setPicked(row.r)}>
                      {row.st.kind === 'ok'
                        ? <input type="checkbox" checked={picked?.id === row.id} onChange={() => setPicked(row.r)} onClick={(e) => e.stopPropagation()}/>
                        : null}
                      {row.st.kind === 'ok' ? <Check size={14} className="chk"/> : <X size={14}/>}
                      <span className="space" style={row.st.kind !== 'ok' ? { textDecoration: 'line-through' } : undefined}>
                        {row.r.name} ({row.r.capacity} pax)
                        {isParent(row.r) && <span className="pill navy" style={{ marginLeft: 6 }}>can be split</span>}
                        {isChild(row.r) && <span className="muted text-sm"> · sub-room</span>}
                      </span>
                      {row.st.kind === 'ok' && <span className="muted text-sm">{row.r.location}</span>}
                      {row.st.kind === 'blocked' && <span className="text-sm">Blocked via {row.st.via}</span>}
                      {row.st.kind === 'unavailable' && <span className="text-sm">Unavailable</span>}
                    </div>
                  ))}
                  {!rows.length && (
                    <div style={{ padding: 20 }}>
                      <EmptyState icon={SearchX} title="No rooms match" description="Adjust your location, date or time."/>
                    </div>
                  )}
                </div>

                {picked && (
                  <div className="row mt" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    {recurError ? <span className="check-msg bad">{recurError}</span> : <span/>}
                    <button className="mrbs-btn" disabled={!!recurError} onClick={() => setModalRoom(picked)}>
                      Confirm &amp; Execute Reservation — {picked.name}
                    </button>
                  </div>
                )}
              </>
            )}

            {!busy && !hasSearched && (
              <EmptyState icon={MapPinned} title="Pick a time to begin"
                description="Set location, date and time on the left, then search for available rooms."/>
            )}
          </div>
        </div>
      </div>

      {modalRoom && (
        <BookingModal resource={modalRoom} date={form.date} start={form.start} end={form.end}
          onClose={() => setModalRoom(null)} onBooked={onBooked}/>
      )}
    </div>
  );
}
