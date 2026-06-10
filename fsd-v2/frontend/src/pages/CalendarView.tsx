import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
// Named-timezone implementation for FullCalendar. Without it the grid can only
// render in the browser's local zone or UTC — a named IANA zone like
// 'Asia/Hong_Kong' silently reverts to UTC — so we register Luxon to make the
// grid render in the *tenant's* zone (see the timeZone prop below).
import luxonPlugin from '@fullcalendar/luxon3';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useRealtime } from '../hooks/useRealtime';
import { useRealtimeStore } from '../stores/realtime';
import { useTimezone } from '../hooks/useTimezone';
import { BookingModal } from '../components/BookingModal';
import { RoomGridView } from '../components/RoomGridView';
import { Combobox, ComboOption } from '../components/Combobox';
import { useAuth } from '../hooks/useAuth';

// Status filter chips (Outlook-style): each toggles whether bookings of that
// status show. They double as the colour legend, so the swatch matches
// statusColor() above. 'Confirmed' is labelled "Booked" to match v1's wording.
const STATUS_FILTERS = [
  { key: 'Confirmed', label: 'Booked', color: 'var(--brand-primary)' },
  { key: 'Pending Approval', label: 'Pending approval', color: 'var(--warning)' },
  { key: 'Checked In', label: 'Checked in', color: 'var(--success)' },
] as const;

// Schedule view — FullCalendar week/month/day grid with the v1 .mrbs panel
// chrome, a room filter, a status legend, and BookingModal-based creation.
// Drag across open space to reserve; drag an existing booking to reschedule;
// click to cancel. Live SSE events refresh the grid.
function pad2(n: number) { return String(n).padStart(2, '0'); }
function hhmm(d: Date) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function isoDate(d: Date) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

// Map a booking status to its accent colour, used as the event card's coloured
// left border. Confirmed/standard bookings inherit the tenant's configured
// --brand-primary (injected onto :root by stores/theme.ts), so the calendar
// matches the Tenant Studio "Live Preview" card instead of a generic red block.
function statusColor(status: string) {
  if (status === 'Pending Approval') return 'var(--warning)';
  if (status === 'No Show') return 'var(--text-muted)';
  if (status === 'Checked In') return 'var(--success)';
  return 'var(--brand-primary)';
}

export function CalendarView() {
  const toast = useToast();
  const fcRef = useRef<any>(null);
  // A live SSE booking event triggers reload() → refetch + re-render. If that
  // fires WHILE the user is mid-drag (rescheduling/resizing an event), the grid
  // re-renders out from under the cursor and the drag is aborted — the card
  // snaps back. In a busy tenant with constant events that makes drag-and-drop
  // practically impossible. So we suppress reloads during an active gesture and
  // replay a single catch-up reload once it ends.
  const interacting = useRef(false);
  const missedReload = useRef(false);
  // Coalesces bursts of reloads (e.g. a reconnect replaying many missed booking
  // events) into a single refetch instead of one bookingsRange call per event.
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [bookings, setBookings] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomFilter, setRoomFilter] = useState('');   // '' = all rooms
  // "My bookings only" toggle — the shared timeline shows every room's bookings
  // by default (intended: it's a shared calendar, private ones redacted), so a
  // general user wanting just their own needs this filter (matches Outlook's
  // "My calendar"). Matched against the caller's id; private bookings owned by
  // others arrive with userId stripped, so they never leak in here.
  const [mineOnly, setMineOnly] = useState(false);
  // Status filter (Outlook-style). Empty set = show all; otherwise only the
  // selected statuses render. Driven by the chips that double as the legend.
  const [statusFilter, setStatusFilter] = useState<Set<string>>(() => new Set());
  const currentUserId = useAuth((s) => s.user?.id);
  // 'calendar' = FullCalendar day/week/month (drag to retime within a day).
  // 'rooms' = our room-column day grid (drag to retime AND re-room). The week
  // grid can't move a booking between rooms — only the room view can.
  const [view, setView] = useState<'calendar' | 'rooms'>('calendar');
  const [roomDate, setRoomDate] = useState<Date>(() => new Date());
  const [modal, setModal] = useState<{ existingBooking?: any; resource?: any; date: string; start: string; end: string } | null>(null);
  // Squeezing a 7-day × 24-hour week grid onto a phone is unreadable, so below
  // the 768px breakpoint we drop to a single-day view. Tracked in state (not a
  // one-shot read) so rotating the device or resizing re-flows live.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const { lastEvent } = useRealtime();
  // Bumped whenever the SSE stream re-establishes after a drop. We force a
  // refetch so the grid catches up on anything that changed while offline,
  // beyond whatever the server could replay from its buffer.
  const reconnectNonce = useRealtimeStore((s) => s.reconnectNonce);
  // The grid renders in the tenant's zone (via the Luxon timeZone prop), so
  // every conversion of a FullCalendar Date back to wall-clock for the booking
  // modal must go through this — never the browser-local hhmm()/isoDate().
  const tz = useTimezone();

  useEffect(() => { api.resources().then(setRooms).catch(() => setRooms([])); reload(); }, []);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Switch the live calendar between day/week when the breakpoint is crossed.
  // initialView only applies at mount, so drive subsequent changes via the API.
  useEffect(() => {
    fcRef.current?.getApi()?.changeView(isMobile ? 'timeGridDay' : 'timeGridWeek');
  }, [isMobile]);

  // Rooms grouped by location for a scannable <optgroup> filter — a flat list
  // of 150 rooms in a native <select> is unusable. Locationless rooms fall
  // under "Other"; groups and rooms are alphabetised.
  const groupedRooms = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const r of rooms) { const k = r.location || 'Other'; (groups[k] ||= []).push(r); }
    return Object.entries(groups)
      .map(([loc, list]) => [loc, list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  }, [rooms]);

  // Flattened, location-grouped options for the searchable room filter. A native
  // <select>+<optgroup> of 100+ rooms spans the whole viewport and forces manual
  // scrolling; the Combobox lets the user type to narrow instead.
  const roomFilterOptions = useMemo<ComboOption[]>(() => {
    const opts: ComboOption[] = [{ value: '', label: 'All rooms' }];
    for (const [loc, list] of groupedRooms) {
      for (const r of list) opts.push({ value: r.id, label: r.name, sub: loc, group: loc });
    }
    return opts;
  }, [groupedRooms]);

  // FullCalendar renders its prev/next/today toolbar icons as
  // `<span class="fc-icon" role="img">` with no accessible text, which trips
  // axe's role-img-alt rule. The enclosing buttons are already labelled, so
  // the icons are purely decorative — mark them aria-hidden after each render.
  function hideDecorativeIcons() {
    // Only one calendar mounts per page, so a document-scoped query is safe
    // and avoids depending on FullCalendar's internal element ref.
    document.querySelectorAll('.fc-icon').forEach((el) => el.setAttribute('aria-hidden', 'true'));
  }
  useEffect(() => {
    if (!lastEvent?.type?.startsWith('booking.')) return;
    // Defer the refresh if the user is actively dragging/resizing — replay it
    // when the gesture ends so the grid still converges, just not mid-drag.
    if (interacting.current) { missedReload.current = true; return; }
    scheduleReload();
    /* eslint-disable-next-line */
  }, [lastEvent]);

  // On SSE reconnect, force a catch-up refetch (skip the initial mount, which
  // already loads via the effect above). Debounced so it coalesces with any
  // booking events the server replays at the same moment.
  useEffect(() => {
    if (reconnectNonce === 0) return;
    if (interacting.current) { missedReload.current = true; return; }
    scheduleReload();
    /* eslint-disable-next-line */
  }, [reconnectNonce]);

  // FullCalendar drag/resize gesture boundaries. While a gesture is in flight we
  // hold off live reloads (see refs above); on completion we flush a single
  // catch-up reload if any event was suppressed. Deferred a tick so the gesture's
  // own eventDrop/eventResize handler (and its confirm dialog) runs first.
  function onInteractionStart() { interacting.current = true; }
  function onInteractionEnd() {
    interacting.current = false;
    if (missedReload.current) {
      missedReload.current = false;
      setTimeout(() => { if (!interacting.current) reload(); }, 0);
    }
  }

  // Debounced reload: collapses a burst of triggers (a reconnect replaying many
  // missed events, or rapid-fire live events) into one bookingsRange fetch.
  function scheduleReload() {
    if (reloadTimer.current) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => { reloadTimer.current = null; reload(); }, 250);
  }

  function reload() {
    // Pull a generous window so prev/next navigation has data without a
    // round-trip per move; FullCalendar clips to the visible range.
    const today = new Date();
    const s = new Date(today); s.setDate(today.getDate() - 31);
    const e = new Date(today); e.setDate(today.getDate() + 62);
    api.bookingsRange(isoDate(s), isoDate(e)).then(setBookings).catch(() => setBookings([]));
  }

  // Overlapping bookings get squeezed into narrow side-by-side columns, clipping
  // the title to "Weekly M…". Give every card a native tooltip with the full
  // time · subject · room so the details are recoverable on hover — including
  // cards collapsed into the "+N more" popover.
  function onEventDidMount(info: any) {
    if (info.event.extendedProps?.subjectHidden) {
      info.el.title = 'Private booking — reserved by another user';
      return;
    }
    const s = info.event.start, e = info.event.end;
    // The grid is in the tenant zone — format the tooltip there too, not in the
    // browser zone, so the hover time matches the row the card sits on.
    const range = s && e ? `${tz.toParts(s).time}–${tz.toParts(e).time}  ` : '';
    const room = info.event.extendedProps?.roomName;
    info.el.title = `${range}${info.event.title}${room ? `\n${room}` : ''}`;
  }

  // Teams/Outlook-style card: stack the time, the subject, and the meeting room
  // on their own lines for the day/week (timeGrid) cards. The month grid gets a
  // COMPACT one-line "time · subject" pill — previously month returned undefined
  // and FullCalendar's default rendering, fighting the .fc-modern-event styling,
  // produced empty bars with no visible title or time at all (QA #4).
  function renderEventContent(arg: any) {
    const hidden = arg.event.extendedProps?.subjectHidden;
    const room = arg.event.extendedProps?.roomName;
    if (arg.view.type.startsWith('dayGrid')) {
      return (
        <div className="evt-inner evt-month">
          {arg.timeText && <span className="fc-event-time">{arg.timeText}</span>}
          <span className="fc-event-title">{arg.event.title}</span>
        </div>
      );
    }
    // Dynamic density: a 30-minute slot is too short for three full-size lines,
    // so the meeting-room line used to get clipped off entirely (QA #2 follow-up).
    // Bucket the card by duration and shrink the fonts/line-height for short
    // bookings so time + subject + room all stay visible. Sub-30-min slots also
    // drop the time onto the subject's line to reclaim a row.
    const startMs = arg.event.start ? +arg.event.start : 0;
    const endMs = arg.event.end ? +arg.event.end : startMs;
    const mins = startMs && endMs > startMs ? (endMs - startMs) / 60000 : 60;
    const density = mins <= 30 ? ' evt-xs' : mins <= 45 ? ' evt-sm' : '';
    return (
      <div className={`evt-inner${density}`}>
        {arg.timeText && <div className="fc-event-time">{arg.timeText}</div>}
        <div className="fc-event-title">{arg.event.title}</div>
        {!hidden && room && <div className="evt-room">{room}</div>}
      </div>
    );
  }

  function toggleStatus(key: string) {
    setStatusFilter((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const events = useMemo(() => bookings
    .filter((b) => b.status !== 'Cancelled')
    // "My bookings only": keep just the caller's own bookings when toggled on.
    .filter((b) => !mineOnly || b.userId === currentUserId)
    // Status filter: empty set means "all"; otherwise keep only chosen statuses.
    .filter((b) => statusFilter.size === 0 || statusFilter.has(b.status))
    .filter((b) => !roomFilter || b.resourceId === roomFilter)
    .map((b) => {
      // A room can be soft-deactivated (isActive=false) while its historical and
      // future bookings remain. list() returns inactive rooms too, so membership
      // isn't enough — read the room's isActive flag. The backend rejects edits to
      // such bookings with NotFoundException('resource not bookable'), so we make
      // them non-editable here and explain why on the drag handlers below.
      const room = rooms.find((r) => r.id === b.resourceId);
      const isRoomActive = !!room?.isActive;
      const rName = room?.name || b.resourceName || 'Inactive room';
      return {
        id: b.id,
        // subjectHidden is set by the API when the booking is private and the
        // caller is neither its owner nor a System Admin: the real title is
        // never sent, so we render a locked, blurred "Private" block instead.
        title: b.subjectHidden ? '🔒 Private' : (b.title || `Booking · ${rName}`),
        start: b.startTime,
        end: b.endTime,
        // White "Live Preview" card: light surface fill + dark text, with the
        // status accent applied only to the heavy left border. FullCalendar sets
        // these as inline styles; fc-modern-event then forces the top/right/bottom
        // borders light via CSS, leaving this borderColor to show on the left edge.
        backgroundColor: 'var(--surface)',
        borderColor: statusColor(b.status),
        textColor: 'var(--text)',
        editable: !b.subjectHidden && isRoomActive,
        classNames: [
          'fc-modern-event',
          ...(b.subjectHidden ? ['evt-private'] : []),
          ...(!isRoomActive ? ['evt-inactive-room'] : []),
        ],
        extendedProps: { subjectHidden: !!b.subjectHidden, isRoomActive, roomName: rName },
      };
    }), [bookings, roomFilter, rooms, mineOnly, currentUserId, statusFilter]);

  function onSelect(info: any) {
    if (!rooms.length) { toast.warning('No bookable rooms'); return; }
    // Teams-style: drag any open slot and choose the room inside the dialog.
    // If a room filter is active we pre-select it; otherwise the modal shows
    // a resource picker so the user can pick from the full list (QA #12).
    const resource = roomFilter ? rooms.find((r) => r.id === roomFilter) : undefined;
    // info.start/end are real instants from a grid now rendered in the tenant
    // zone, so split them back to tenant-zone wall-clock (NOT browser-local
    // hhmm/isoDate) — otherwise the modal would re-interpret the browser time
    // as a tenant time and the saved slot would jump.
    const sParts = tz.toParts(info.start);
    const eParts = tz.toParts(info.end);
    // Month view (dayGridMonth) hands back an all-day selection running
    // midnight→midnight, which formats to "00:00 – 00:00" and a 0-minute
    // booking the validator rejects. Default to a sensible 09:00–10:00 working
    // hour (Teams-style) — the user can fine-tune it in the modal.
    const start = info.allDay ? '09:00' : sParts.time;
    const end = info.allDay ? '10:00' : eParts.time;
    setModal({ resource, date: sParts.date, start, end });
    fcRef.current?.getApi()?.unselect();
  }

  // Restore a booking to its pre-drag values (the "Undo" affordance).
  async function undoChange(bookingId: string, prev: any) {
    try { await api.updateBooking(bookingId, prev); reload(); }
    catch (e: any) { toast.error('Undo failed', e.displayMessage || e.message); }
  }

  // Persist a calendar edit optimistically and surface a Gmail-style Undo toast
  // instead of a blocking confirm. The card has already moved on screen, so a
  // modal dialog on every drag/resize just interrupted the gesture; this keeps
  // the calendar fluid while still making the change reversible. On failure we
  // run `revert` to snap the card back.
  async function applyWithUndo(
    bookingId: string,
    next: any,
    prev: any,
    opts: { title: string; failTitle: string; revert: () => void },
  ) {
    try {
      await api.updateBooking(bookingId, next);
      reload();
      const canUndo = prev && prev.startTime && prev.endTime;
      toast.push({
        title: opts.title,
        kind: 'success',
        duration: 8000, // a beat longer than default so Undo is actually reachable
        ...(canUndo ? { action: { label: 'Undo', onClick: () => undoChange(bookingId, prev) } } : {}),
      });
    } catch (e: any) {
      toast.error(opts.failTitle, e.displayMessage || e.message);
      opts.revert();
    }
  }

  async function onDrop(info: any) {
    // A private booking the caller can't see is read-only; bail before the
    // backend would reject the edit anyway.
    if (info.event.extendedProps?.subjectHidden) { info.revert(); return; }
    // The room was deactivated; the backend would reject this with a confusing
    // "not bookable" 404. Explain it and snap the card back.
    if (!info.event.extendedProps?.isRoomActive) {
      toast.error('Cannot reschedule', 'This room is no longer active or bookable.');
      info.revert();
      return;
    }
    const newStart: Date = info.event.start;
    // Dragging in the month grid (or onto an all-day cell) yields an event with a
    // null end, so info.event.end.toISOString() threw a TypeError that silently
    // aborted the drop. Reconstruct the end by preserving the original duration.
    let newEnd: Date | null = info.event.end;
    if (!newEnd) {
      const oldDuration = info.oldEvent.end
        ? info.oldEvent.end.getTime() - info.oldEvent.start.getTime()
        : 3_600_000; // fall back to 1h if the prior end was also missing
      newEnd = new Date(newStart.getTime() + oldDuration);
    }
    const b = bookings.find((x) => x.id === info.event.id);
    await applyWithUndo(
      info.event.id,
      { startTime: newStart.toISOString(), endTime: newEnd.toISOString() },
      { startTime: b?.startTime, endTime: b?.endTime },
      { title: `Moved “${info.event.title}”`, failTitle: 'Reschedule failed', revert: () => info.revert() },
    );
  }

  // Resize is a distinct gesture from a move: the start usually stays put and
  // only the duration changes, so onDrop's "Move to <time>?" copy reads as
  // confusing ("Move to 09:00?" when 09:00 never moved). Prompt about the new
  // duration instead.
  async function onResize(info: any) {
    if (info.event.extendedProps?.subjectHidden) { info.revert(); return; }
    if (!info.event.extendedProps?.isRoomActive) {
      toast.error('Cannot change duration', 'This room is no longer active or bookable.');
      info.revert();
      return;
    }
    const start: Date = info.event.start;
    const end: Date = info.event.end;
    const b = bookings.find((x) => x.id === info.event.id);
    await applyWithUndo(
      info.event.id,
      { startTime: start.toISOString(), endTime: end.toISOString() },
      { startTime: b?.startTime, endTime: b?.endTime },
      { title: `Updated “${info.event.title}”`, failTitle: 'Update failed', revert: () => info.revert() },
    );
  }

  // Teams/Outlook parity: clicking an event opens its details for editing
  // (adjust time, title, meeting URL) with a "Cancel booking" button inside the
  // dialog — not an immediate cancel prompt, which was the hostile legacy UX.
  function onEventClick(info: any) {
    // Don't open a booking whose subject is hidden from the caller.
    if (info.event.extendedProps?.subjectHidden) {
      toast.info('Private booking', 'This slot is reserved privately by another user.');
      return;
    }
    const fullBooking = bookings.find((b) => b.id === info.event.id);
    if (!fullBooking) return;
    // date/start/end are placeholders — the modal prefills from the booking's
    // stored instant in the tenant zone; they only matter for the create path.
    setModal({
      existingBooking: fullBooking,
      resource: rooms.find((r) => r.id === fullBooking.resourceId),
      date: info.event.start ? isoDate(info.event.start) : isoDate(new Date()),
      start: info.event.start ? hhmm(info.event.start) : '09:00',
      end: info.event.end ? hhmm(info.event.end) : '10:00',
    });
  }

  // Room columns for the room-grid view: bookable (active) rooms, narrowed to
  // the filtered room when one is selected so a single-room day reads cleanly.
  const roomColumns = useMemo(
    () => rooms.filter((r) => r.isActive !== false && (!roomFilter || r.id === roomFilter)),
    [rooms, roomFilter],
  );

  // Drag a booking onto another room/time in the room grid → confirm, then
  // persist the room move + retime in one call (the backend re-runs the full
  // conflict + operating-hours check against the new room).
  async function onRoomMove(bookingId: string, resourceId: string, startISO: string, endISO: string) {
    const b = bookings.find((x) => x.id === bookingId);
    const room = rooms.find((r) => r.id === resourceId);
    const moved = !!b && b.resourceId !== resourceId;
    await applyWithUndo(
      bookingId,
      { resourceId, startTime: startISO, endTime: endISO },
      b ? { resourceId: b.resourceId, startTime: b.startTime, endTime: b.endTime } : null,
      {
        title: moved ? `Moved “${b?.title || 'booking'}” to ${room?.name || 'room'}` : `Rescheduled “${b?.title || 'booking'}”`,
        failTitle: moved ? 'Move failed' : 'Reschedule failed',
        revert: () => reload(),
      },
    );
  }

  // Click empty space in a room column → open the booking modal pre-filled with
  // that room and slot. The grid already handed us tenant-zone-correct instants;
  // split them back to tenant wall-clock for the modal (not browser-local).
  function onRoomCreate(resourceId: string, startISO: string, endISO: string) {
    const s = tz.toParts(startISO); const e = tz.toParts(endISO);
    setModal({ resource: rooms.find((r) => r.id === resourceId), date: s.date, start: s.time, end: e.time });
  }

  // Click an existing block → open it for editing (same path as a calendar click).
  function onRoomOpen(bookingId: string) {
    const fullBooking = bookings.find((b) => b.id === bookingId);
    if (!fullBooking) return;
    const s = tz.toParts(fullBooking.startTime); const e = tz.toParts(fullBooking.endTime);
    setModal({
      existingBooking: fullBooking,
      resource: rooms.find((r) => r.id === fullBooking.resourceId),
      date: s.date, start: s.time, end: e.time,
    });
  }

  function shiftRoomDate(days: number) {
    setRoomDate((d) => { const n = new Date(d); n.setDate(n.getDate() + days); return n; });
  }
  // The tenant-zone calendar day the room grid renders. Derived from the Date so
  // stepping ±1 day stays correct across the tenant/browser zone gap.
  const roomDateStr = tz.toParts(roomDate).date;

  return (
    <div className="mrbs">
      <h1 className="fsd-page-title">Schedule</h1>

      <div className="panel">
        <div className="ph cal-head">
          <span className="cal-title">
            {view === 'rooms'
              ? 'Rooms — drag a booking sideways to change room, up/down to retime'
              : 'Calendar — drag across open slots to reserve'}
          </span>
          <div className="row gap-sm cal-ctrls">
            <div className="seg" role="group" aria-label="View mode">
              <button type="button" className={`seg-btn${view === 'calendar' ? ' active' : ''}`}
                aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}>Calendar</button>
              <button type="button" className={`seg-btn${view === 'rooms' ? ' active' : ''}`}
                aria-pressed={view === 'rooms'} onClick={() => setView('rooms')}>Rooms</button>
            </div>
            <Combobox className="cal-room-filter" ariaLabel="Filter by room"
                      value={roomFilter} onChange={setRoomFilter}
                      placeholder="All rooms" options={roomFilterOptions} />
            {/* "My bookings only" — pressed state filters the grid to the
                caller's own bookings (Outlook "My calendar"). */}
            <button type="button" className={`seg-btn cal-mine-btn${mineOnly ? ' active' : ''}`}
                    aria-pressed={mineOnly} onClick={() => setMineOnly((v) => !v)}>
              My bookings
            </button>
          </div>
        </div>

        {view === 'rooms' && (
          <div className="pb">
            <div className="row" style={{ alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--asl-line)' }}>
              <button type="button" className="btn ghost" onClick={() => shiftRoomDate(-1)} aria-label="Previous day">‹</button>
              <button type="button" className="btn ghost" onClick={() => setRoomDate(new Date())}>Today</button>
              <button type="button" className="btn ghost" onClick={() => shiftRoomDate(1)} aria-label="Next day">›</button>
              <strong style={{ marginLeft: 8 }}>
                {roomDate.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: tz.tz })}
              </strong>
              <span className="muted text-sm" style={{ marginLeft: 'auto' }}>Times shown in {tz.label}</span>
            </div>
            <RoomGridView
              dateStr={roomDateStr}
              tz={tz}
              rooms={roomColumns}
              bookings={bookings}
              onMove={onRoomMove}
              onCreate={onRoomCreate}
              onOpen={onRoomOpen}
            />
          </div>
        )}

        <div className="pb" style={{ display: view === 'calendar' ? undefined : 'none' }}>
          <FullCalendar
            ref={fcRef}
            plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin, luxonPlugin]}
            // Render the grid in the tenant's zone, not the browser's. Otherwise
            // a traveller in New York sees a booking stored as 09:00 Hong Kong
            // time rendered at their local 21:00 the day before — and a slot they
            // drag to "09:00" on screen is saved as 09:00 HK and visibly jumps.
            // The Luxon plugin above makes this named zone resolvable.
            timeZone={tz.tz}
            initialView={isMobile ? 'timeGridDay' : 'timeGridWeek'}
            height={620}
            selectable
            editable
            eventDurationEditable
            nowIndicator
            // Place overlapping bookings fully side-by-side (no overlap) and cap
            // the stack at 3 columns; further overlaps collapse into a "+N more"
            // link that opens a popover showing each booking at readable width.
            slotEventOverlap={false}
            eventMaxStack={3}
            moreLinkClick="popover"
            // Render month-grid events as solid blocks (not the default tiny dot
            // rows), so the time + subject pill is actually visible (QA #4).
            eventDisplay="block"
            // Always show the start time on month pills, paired with the subject.
            displayEventTime
            headerToolbar={isMobile
              ? { left: 'prev,next', center: 'title', right: 'timeGridDay,dayGridMonth' }
              : { left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' }}
            events={events}
            eventContent={renderEventContent}
            select={onSelect}
            eventDragStart={onInteractionStart}
            eventDragStop={onInteractionEnd}
            eventResizeStart={onInteractionStart}
            eventResizeStop={onInteractionEnd}
            eventDrop={onDrop}
            eventResize={onResize}
            eventClick={onEventClick}
            eventDidMount={onEventDidMount}
            viewDidMount={hideDecorativeIcons}
            datesSet={hideDecorativeIcons}
          />
        </div>

        <div className="pb" style={{ padding: '10px 14px', borderTop: '1px solid var(--asl-line)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          {/* The colour legend doubles as a status filter: click a chip to show
              only that status; click again to clear. Pressed chips fill with
              their accent so the active filter is obvious. */}
          {STATUS_FILTERS.map((s) => {
            const on = statusFilter.has(s.key);
            return (
              <button key={s.key} type="button" aria-pressed={on}
                      className={`pill cal-status-chip${on ? ' active' : ''}`}
                      style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: `4px solid ${s.color}`, ...(on ? { background: `color-mix(in srgb, ${s.color} 14%, var(--surface))`, borderColor: s.color } : {}) }}
                      onClick={() => toggleStatus(s.key)}>
                {s.label}
              </button>
            );
          })}
          {statusFilter.size > 0 && (
            <button type="button" className="btn ghost sm" onClick={() => setStatusFilter(new Set())}>
              Clear
            </button>
          )}
          <span className="muted text-sm" style={{ marginLeft: 'auto' }}>
            Click a status to filter · drag a time range to book.
          </span>
        </div>
      </div>

      {modal && (
        <BookingModal existingBooking={modal.existingBooking} resource={modal.resource} resources={rooms} bookings={bookings} date={modal.date} start={modal.start} end={modal.end}
          onClose={() => setModal(null)} onBooked={() => { setModal(null); reload(); }} />
      )}
    </div>
  );
}
