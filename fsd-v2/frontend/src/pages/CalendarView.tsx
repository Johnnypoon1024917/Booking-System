import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../stores/toast';
import { useRealtime } from '../hooks/useRealtime';
import { BookingModal } from '../components/BookingModal';
import { confirmDialog } from '../stores/confirm';

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
  const [bookings, setBookings] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [roomFilter, setRoomFilter] = useState('');   // '' = all rooms
  const [modal, setModal] = useState<{ existingBooking?: any; resource?: any; date: string; start: string; end: string } | null>(null);
  // Squeezing a 7-day × 24-hour week grid onto a phone is unreadable, so below
  // the 768px breakpoint we drop to a single-day view. Tracked in state (not a
  // one-shot read) so rotating the device or resizing re-flows live.
  const [isMobile, setIsMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const { lastEvent } = useRealtime();

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

  // FullCalendar renders its prev/next/today toolbar icons as
  // `<span class="fc-icon" role="img">` with no accessible text, which trips
  // axe's role-img-alt rule. The enclosing buttons are already labelled, so
  // the icons are purely decorative — mark them aria-hidden after each render.
  function hideDecorativeIcons() {
    // Only one calendar mounts per page, so a document-scoped query is safe
    // and avoids depending on FullCalendar's internal element ref.
    document.querySelectorAll('.fc-icon').forEach((el) => el.setAttribute('aria-hidden', 'true'));
  }
  useEffect(() => { if (lastEvent?.type?.startsWith('booking.')) reload(); /* eslint-disable-next-line */ }, [lastEvent]);

  function reload() {
    // Pull a generous window so prev/next navigation has data without a
    // round-trip per move; FullCalendar clips to the visible range.
    const today = new Date();
    const s = new Date(today); s.setDate(today.getDate() - 31);
    const e = new Date(today); e.setDate(today.getDate() + 62);
    api.bookingsRange(isoDate(s), isoDate(e)).then(setBookings).catch(() => setBookings([]));
  }

  function roomName(id: string) { return rooms.find((r) => r.id === id)?.name || 'Room'; }

  const events = useMemo(() => bookings
    .filter((b) => b.status !== 'Cancelled')
    .filter((b) => !roomFilter || b.resourceId === roomFilter)
    .map((b) => ({
      id: b.id,
      // subjectHidden is set by the API when the booking is private and the
      // caller is neither its owner nor a System Admin: the real title is
      // never sent, so we render a locked, blurred "Private" block instead.
      title: b.subjectHidden ? '🔒 Private' : (b.title || `Booking · ${roomName(b.resourceId)}`),
      start: b.startTime,
      end: b.endTime,
      // White "Live Preview" card: light surface fill + dark text, with the
      // status accent applied only to the heavy left border. FullCalendar sets
      // these as inline styles; fc-modern-event then forces the top/right/bottom
      // borders light via CSS, leaving this borderColor to show on the left edge.
      backgroundColor: 'var(--surface)',
      borderColor: statusColor(b.status),
      textColor: 'var(--text)',
      editable: !b.subjectHidden,
      classNames: ['fc-modern-event', ...(b.subjectHidden ? ['evt-private'] : [])],
      extendedProps: { subjectHidden: !!b.subjectHidden },
    })), [bookings, roomFilter, rooms]);

  function onSelect(info: any) {
    if (!rooms.length) { toast.warning('No bookable rooms'); return; }
    // Teams-style: drag any open slot and choose the room inside the dialog.
    // If a room filter is active we pre-select it; otherwise the modal shows
    // a resource picker so the user can pick from the full list (QA #12).
    const resource = roomFilter ? rooms.find((r) => r.id === roomFilter) : undefined;
    // Month view (dayGridMonth) hands back an all-day selection running
    // midnight→midnight, which formats to "00:00 – 00:00" and a 0-minute
    // booking the validator rejects. Default to a sensible 09:00–10:00 working
    // hour (Teams-style) — the user can fine-tune it in the modal.
    const start = info.allDay ? '09:00' : hhmm(info.start);
    const end = info.allDay ? '10:00' : hhmm(info.end);
    setModal({ resource, date: isoDate(info.start), start, end });
    fcRef.current?.getApi()?.unselect();
  }

  async function onDrop(info: any) {
    // A private booking the caller can't see is read-only; bail before the
    // backend would reject the edit anyway.
    if (info.event.extendedProps?.subjectHidden) { info.revert(); return; }
    const ok = await confirmDialog({
      title: 'Reschedule booking',
      message: `Move "${info.event.title}" to ${info.event.start?.toLocaleString()}?`,
      confirmText: 'Reschedule',
    });
    if (!ok) { info.revert(); return; }
    try {
      await api.updateBooking(info.event.id, {
        startTime: info.event.start.toISOString(),
        endTime: info.event.end.toISOString(),
      });
      reload();
    } catch (e: any) { toast.error('Reschedule failed', e.displayMessage || e.message); info.revert(); }
  }

  // Resize is a distinct gesture from a move: the start usually stays put and
  // only the duration changes, so onDrop's "Move to <time>?" copy reads as
  // confusing ("Move to 09:00?" when 09:00 never moved). Prompt about the new
  // duration instead.
  async function onResize(info: any) {
    if (info.event.extendedProps?.subjectHidden) { info.revert(); return; }
    const start: Date = info.event.start;
    const end: Date = info.event.end;
    const mins = Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
    const human = mins % 60 === 0 ? `${mins / 60}h` : mins > 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
    const ok = await confirmDialog({
      title: 'Change duration',
      message: `Change duration of "${info.event.title}" to ${human} (${hhmm(start)}–${hhmm(end)})?`,
      confirmText: 'Change duration',
    });
    if (!ok) { info.revert(); return; }
    try {
      await api.updateBooking(info.event.id, {
        startTime: start.toISOString(),
        endTime: end.toISOString(),
      });
      reload();
    } catch (e: any) { toast.error('Update failed', e.displayMessage || e.message); info.revert(); }
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

  return (
    <div className="mrbs">
      <h1 className="fsd-page-title">Schedule</h1>

      <div className="panel">
        <div className="ph cal-head">
          <span className="cal-title">Calendar — drag across open slots to reserve</span>
          <div className="row gap-sm cal-ctrls">
            <select className="d-in" aria-label="Filter by room" style={{ width: 200, maxWidth: '60vw' }} value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)}>
              <option value="">All rooms</option>
              {groupedRooms.map(([loc, list]) => (
                <optgroup key={loc} label={loc}>
                  {list.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <div className="pb">
          <FullCalendar
            ref={fcRef}
            plugins={[timeGridPlugin, dayGridPlugin, interactionPlugin]}
            initialView={isMobile ? 'timeGridDay' : 'timeGridWeek'}
            height={620}
            selectable
            editable
            eventDurationEditable
            nowIndicator
            headerToolbar={isMobile
              ? { left: 'prev,next', center: 'title', right: 'timeGridDay,dayGridMonth' }
              : { left: 'prev,next today', center: 'title', right: 'timeGridDay,timeGridWeek,dayGridMonth' }}
            events={events}
            select={onSelect}
            eventDrop={onDrop}
            eventResize={onResize}
            eventClick={onEventClick}
            viewDidMount={hideDecorativeIcons}
            datesSet={hideDecorativeIcons}
          />
        </div>

        <div className="pb" style={{ padding: '10px 14px', borderTop: '1px solid var(--asl-line)', display: 'flex', alignItems: 'center' }}>
          <span className="pill" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--brand-primary)' }}>Booked</span>
          <span className="pill" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--warning)', marginLeft: 8 }}>Pending approval</span>
          <span className="pill" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderLeft: '4px solid var(--success)', marginLeft: 8 }}>Checked in</span>
          <span className="muted text-sm" style={{ marginLeft: 12 }}>
            Drag across a time range, then choose a room in the popup to book it.
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
