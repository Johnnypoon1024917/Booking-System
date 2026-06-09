import { useEffect, useMemo, useState } from 'react';
import { Search as SearchIcon, SearchX, MapPinned, Check, X, Combine } from 'lucide-react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useTenant } from '../stores/tenant';
import { useAuth } from '../hooks/useAuth';
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
//
// The time-slot granularity is no longer a hard-coded 30 minutes: it tracks the
// tenant's configured minimum booking duration so the dropdowns can actually
// offer the interval the Settings screen promises. A room set to a 15-minute
// minimum used to be un-bookable at 15-minute marks because the picker only
// stepped in 30s — the config and the form silently disagreed (QA #14).
function clampStep(min: number) { return Math.min(60, Math.max(5, Math.round(min) || 30)); }

function initialStart(step: number) {
  const d = new Date();
  d.setMinutes(d.getMinutes() + ((step - (d.getMinutes() % step)) % step), 0, 0);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function addMinutes(hhmm: string, mins: number) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function hmToMin(hhmm: string) { const [h, m] = hhmm.split(':').map(Number); return (h || 0) * 60 + (m || 0); }
function minToHHMM(t: number) { return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }

type CellKind = 'ok' | 'blocked' | 'unavailable';
interface Row { id: string; r: any; depth: number; st: { kind: CellKind; via?: string }; }

export function Search() {
  const toast = useToast();
  const tenant = useTenant((s) => s.customization);
  const user = useAuth((s) => s.user);
  const { allowsPattern, rules } = useBookingRules();

  // Slot granularity = the tenant's minimum booking duration (clamped to a sane
  // 5–60 min), so the picker honours the configured minimum (QA #14).
  const STEP = clampStep(rules.minMinutes);

  const today = new Date().toISOString().slice(0, 10);
  const start0 = initialStart(STEP);
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
  // Multi-select (was a single `picked`): the user may now tick several
  // sub-rooms so we can offer the "book the whole space instead" nudge when the
  // selection covers 2+ children of the same parent.
  const [pickedIds, setPickedIds] = useState<string[]>([]);
  const [modalRoom, setModalRoom] = useState<any | null>(null);
  function togglePick(r: any) {
    setPickedIds((ids) => ids.includes(r.id) ? ids.filter((x) => x !== r.id) : [...ids, r.id]);
  }

  // Admin-configured working-hours window + "is the chosen date today" so we
  // can grey out slots earlier than now.
  const hours = useMemo(() => {
    const c: any = tenant || {};
    const sh = Number.isInteger(c.calendar_start_hour) ? c.calendar_start_hour
      : Number.isInteger(c.calendarStartHour) ? c.calendarStartHour : 8;
    const eh = Number.isInteger(c.calendar_end_hour) ? c.calendar_end_hour
      : Number.isInteger(c.calendarEndHour) ? c.calendarEndHour : 20;
    const isToday = form.date === new Date().toISOString().slice(0, 10);
    const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
    return { sh, eh, isToday, nowMin };
  }, [tenant, form.date]);

  // Start slots stop one step *before* closing — you can't start a meeting at
  // the moment the calendar day ends.
  const startSlots = useMemo(() => {
    const { sh, eh, isToday, nowMin } = hours;
    const out: { value: string; past: boolean }[] = [];
    for (let m = sh * 60; m <= eh * 60 - STEP; m += STEP) {
      out.push({ value: minToHHMM(m), past: isToday && m < nowMin });
    }
    return out;
  }, [hours, STEP]);

  // End slots are generated from the chosen start (start+30 … closing) so the
  // dropdown can never settle on a value absent from its own list. The old
  // shared-array approach went blank whenever start+60 overshot closing (e.g.
  // start 20:00 → default end 21:00, which wasn't in the 08:00–20:00 array).
  const endSlots = useMemo(() => {
    const { eh, isToday, nowMin } = hours;
    const out: { value: string; past: boolean }[] = [];
    for (let m = hmToMin(form.start) + STEP; m <= eh * 60; m += STEP) {
      out.push({ value: minToHHMM(m), past: isToday && m < nowMin });
    }
    return out;
  }, [hours, form.start, STEP]);

  // Keep start/end inside the working-hours window. Tenant config loads async
  // (and "now" may already be past closing), so a default like 21:30 can land
  // outside the slot lists — snap it back in so the selects never show blank.
  useEffect(() => {
    const { sh, eh } = hours;
    const maxStart = eh * 60 - STEP;
    setForm((f) => {
      let s = hmToMin(f.start);
      if (s < sh * 60 || s > maxStart) s = sh * 60;
      let e = hmToMin(f.end);
      if (e <= s || e > eh * 60) e = Math.min(s + 60, eh * 60);
      const sv = minToHHMM(s), ev = minToHHMM(e);
      return sv === f.start && ev === f.end ? f : { ...f, start: sv, end: ev };
    });
  }, [hours, STEP]);

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

  // Currently-ticked, bookable rooms.
  const pickedRooms = useMemo(
    () => rows.filter((x) => x.st.kind === 'ok' && pickedIds.includes(x.id)).map((x) => x.r),
    [rows, pickedIds],
  );
  const soloPick = pickedRooms.length === 1 ? pickedRooms[0] : null;

  // Whole-room nudge (spec): if the user ticks 2+ sub-rooms of the SAME parent,
  // suggest reserving the whole parent space in one booking instead of cobbling
  // the halves together. Only surfaced when the parent itself is bookable.
  const nudge = useMemo(() => {
    const byParent: Record<string, any[]> = {};
    for (const r of pickedRooms) {
      if (isChild(r) && r.parentResourceId) {
        (byParent[r.parentResourceId] = byParent[r.parentResourceId] || []).push(r);
      }
    }
    for (const pid of Object.keys(byParent)) {
      if (byParent[pid].length < 2) continue;
      const parentRow = rows.find((x) => x.id === pid);
      if (parentRow && parentRow.st.kind === 'ok') {
        return { parent: parentRow.r, children: byParent[pid] };
      }
    }
    return null;
  }, [pickedRooms, rows]);

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
        // Default the location to the user's own region instead of whichever
        // happens to sort first, so a Hong Kong user doesn't re-pick it every
        // visit. Fall back to the first available location when their home
        // region has no bookable rooms (or isn't set).
        const home = (user?.regionAccess || []).find((r) => locs.includes(r));
        setForm((f) => ({ ...f, region: home || (locs[0] as string) || 'Hong Kong' }));
      } catch { /* non-fatal */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function search() {
    setBusy(true); setHasSearched(true); setPickedIds([]);
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
    // Default the end to start+60, but clamp at closing so we never produce a
    // value the end dropdown can't represent.
    const endCap = hours.eh * 60;
    setForm((f) => {
      let e = hmToMin(f.end);
      if (e <= hmToMin(v) || e > endCap) e = Math.min(hmToMin(v) + 60, endCap);
      return { ...f, start: v, end: minToHHMM(e) };
    });
  }
  function onBooked() { setModalRoom(null); setPickedIds([]); toast.success('Reservation submitted'); search(); }

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
                    {startSlots.map((t) => <option key={'s' + t.value} value={t.value} disabled={t.past}>{t.value}{t.past ? ' (past)' : ''}</option>)}
                  </select>
                </label>
                <label className="fld">
                  <span>End Time</span>
                  <select value={form.end} onChange={(e) => set('end', e.target.value)}>
                    {endSlots.map((t) => <option key={'e' + t.value} value={t.value} disabled={t.past}>{t.value}</option>)}
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
                    {/* "Weekdays" removed: the backend recurrence enum only accepts
                        daily/weekly/bi-weekly/monthly/custom, so it 400'd on submit. */}
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
                         onClick={() => row.st.kind === 'ok' && togglePick(row.r)}>
                      {/* Tree connector so a sub-room reads as physically inside
                          its parent (└─), not just an indented sibling. */}
                      {row.depth > 0 && <span className="tree-branch" aria-hidden="true">└─</span>}
                      {row.st.kind === 'ok'
                        ? <input type="checkbox" checked={pickedIds.includes(row.id)} onChange={() => togglePick(row.r)} onClick={(e) => e.stopPropagation()}/>
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

                {/* Whole-room nudge: the user ticked 2+ halves of one space, so
                    suggest booking the parent in a single reservation. */}
                {nudge && (
                  <div className="avail-note mt" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <span>
                      <Combine size={14}/> You picked {nudge.children.map((c: any) => c.name).join(' + ')}.
                      {' '}Book the whole <b>{nudge.parent.name}</b> ({nudge.parent.capacity} pax) in one reservation instead?
                    </span>
                    <button className="mrbs-btn" disabled={!!recurError} onClick={() => setModalRoom(nudge.parent)}>
                      Book whole {nudge.parent.name}
                    </button>
                  </div>
                )}

                {soloPick && !nudge && (
                  <div className="row mt" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    {recurError ? <span className="check-msg bad">{recurError}</span> : <span/>}
                    <button className="mrbs-btn" disabled={!!recurError} onClick={() => setModalRoom(soloPick)}>
                      Confirm &amp; Execute Reservation — {soloPick.name}
                    </button>
                  </div>
                )}

                {pickedRooms.length > 1 && !nudge && (
                  <p className="muted text-sm mt">
                    Select a single room to book it, or tick sub-rooms of the same space to book it whole.
                  </p>
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
        <BookingModal resource={modalRoom} date={form.date}
          // All-day searches checked 00:00–23:59 availability, so the modal must
          // confirm the same window — passing the hidden dropdown times let a
          // user book 09:00–10:00 while believing they'd reserved the whole day.
          start={form.allDay ? '00:00' : form.start}
          end={form.allDay ? '23:59' : form.end}
          allDay={form.allDay}
          // Carry the user's recurring-schedule choices into the dialog instead
          // of dropping them on open.
          initialRecur={form.recur}
          initialPattern={form.pattern as 'daily' | 'weekly' | 'bi-weekly' | 'monthly'}
          initialUntil={form.endDate}
          onClose={() => setModalRoom(null)} onBooked={onBooked}/>
      )}
    </div>
  );
}
