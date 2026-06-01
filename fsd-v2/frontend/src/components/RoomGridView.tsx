import { useMemo, useRef } from 'react';

// Room-column day view ("resource timeline") — our own, license-free answer to
// FullCalendar's premium @fullcalendar/resource-timegrid. The standard
// timeGridWeek only has columns for DAYS, so a booking can be dragged to a
// different time but never to a different ROOM. Here the X-axis is rooms and the
// Y-axis is the day's hours, so a booking can be dragged BOTH down (retime) and
// sideways (re-room) — the Outlook/Teams cross-room orchestration the calendar
// always implied but couldn't deliver.
//
// Everything is positioned in the TENANT's timezone, the same zone the
// FullCalendar grid renders in (via its Luxon timeZone prop). We never read a
// booking's browser-local hours; instead tz.toParts() projects each stored UTC
// instant to tenant wall-clock, and tz.toUtcIso() converts a drop/click back to
// a UTC instant for the write. Mixing the two zones would make a 09:00 tenant
// booking render at the viewer's local hour and jump on save.

interface Room { id: string; name: string; location?: string; isActive?: boolean }
interface Booking {
  id: string;
  resourceId: string;
  startTime: string;
  endTime: string;
  title?: string;
  status: string;
  subjectHidden?: boolean;
  resourceName?: string;
}

// The slice of useTimezone() this view needs.
interface Tz {
  toParts: (d: Date | string) => { date: string; time: string };
  toUtcIso: (dateStr: string, timeStr: string) => string;
}

interface Props {
  dateStr: string;            // tenant-zone day to render, 'YYYY-MM-DD'
  tz: Tz;                     // tenant-zone conversion helpers (useTimezone)
  rooms: Room[];              // room columns (caller filters to bookable rooms)
  bookings: Booking[];        // all loaded bookings; we slice to this day
  startHour?: number;         // first visible hour (default 7)
  endHour?: number;           // last visible hour, exclusive (default 21)
  onMove: (bookingId: string, resourceId: string, startISO: string, endISO: string) => void;
  onCreate: (resourceId: string, startISO: string, endISO: string) => void;
  onOpen: (bookingId: string) => void;
}

const HOUR_PX = 48;          // vertical pixels per hour
const SNAP_MIN = 15;         // drag/drop snaps to this granularity
const MIN_BLOCK_PX = 20;     // floor so a 15-min booking is still grabbable

function pad2(n: number) { return String(n).padStart(2, '0'); }
function parseMin(t: string) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function minToHHMM(min: number) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }

function statusColor(status: string) {
  if (status === 'Pending Approval') return 'var(--warning)';
  if (status === 'No Show') return 'var(--text-muted)';
  if (status === 'Checked In') return 'var(--success)';
  return 'var(--brand-primary)';
}

// What the user grabbed: which booking, how long it is (exact, from the stored
// instants so duration survives a re-room across a DST edge), and how far below
// the block's top edge the cursor was — so the drop preserves the grab point.
interface DragState { id: string; durationMs: number; grabOffsetPx: number }

export function RoomGridView({
  dateStr, tz, rooms, bookings, startHour = 7, endHour = 21, onMove, onCreate, onOpen,
}: Props) {
  const drag = useRef<DragState | null>(null);
  const winLo = startHour * 60;
  const winHi = endHour * 60;
  const bodyHeight = (endHour - startHour) * HOUR_PX;
  const hours = useMemo(
    () => Array.from({ length: endHour - startHour }, (_, i) => startHour + i),
    [startHour, endHour],
  );

  // Project a booking onto this day as a [startMin, endMin] minutes-of-day range
  // in tenant wall-clock, clamped to the visible window — or null if it doesn't
  // intersect the visible part of this day.
  function dayRange(b: Booking): { startMin: number; endMin: number } | null {
    const sp = tz.toParts(b.startTime);
    const ep = tz.toParts(b.endTime);
    if (ep.date < dateStr || sp.date > dateStr) return null;
    const startMin = sp.date < dateStr ? 0 : parseMin(sp.time);
    let endMin = ep.date > dateStr ? 24 * 60 : parseMin(ep.time);
    // Ends exactly at this day's 00:00 → it belongs to the previous day.
    if (ep.date === dateStr && endMin === 0 && sp.date < dateStr) return null;
    if (endMin <= startMin) return null;
    if (endMin <= winLo || startMin >= winHi) return null; // outside visible hours
    return { startMin, endMin };
  }

  // Bookings on this day, bucketed by room. Cancelled bookings drop out.
  const byRoom = useMemo(() => {
    const map = new Map<string, { b: Booking; range: { startMin: number; endMin: number } }[]>();
    for (const r of rooms) map.set(r.id, []);
    for (const b of bookings) {
      if (b.status === 'Cancelled' || !map.has(b.resourceId)) continue;
      const range = dayRange(b);
      if (range) map.get(b.resourceId)!.push({ b, range });
    }
    return map;
    // dayRange depends on dateStr/tz/window — all captured below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, bookings, dateStr, tz, winLo, winHi]);

  function boxOf(range: { startMin: number; endMin: number }) {
    const top = ((clamp(range.startMin, winLo, winHi) - winLo) / 60) * HOUR_PX;
    const bottom = ((clamp(range.endMin, winLo, winHi) - winLo) / 60) * HOUR_PX;
    return { top, height: Math.max(MIN_BLOCK_PX, bottom - top) };
  }

  // Snap a pointer Y (relative to a column's top) to a tenant-zone HH:MM.
  function yToTime(yPx: number): string {
    const rawMin = (yPx / HOUR_PX) * 60 + winLo;
    const snapped = Math.round(rawMin / SNAP_MIN) * SNAP_MIN;
    return minToHHMM(clamp(snapped, winLo, winHi));
  }

  function onBlockDragStart(e: React.DragEvent, b: Booking) {
    drag.current = {
      id: b.id,
      durationMs: new Date(b.endTime).getTime() - new Date(b.startTime).getTime(),
      grabOffsetPx: e.clientY - e.currentTarget.getBoundingClientRect().top,
    };
    e.dataTransfer.setData('text/plain', b.id); // Firefox needs a payload to start DnD
    e.dataTransfer.effectAllowed = 'move';
  }

  function onColumnDrop(e: React.DragEvent, room: Room) {
    e.preventDefault();
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const startISO = tz.toUtcIso(dateStr, yToTime(e.clientY - colTop - d.grabOffsetPx));
    const endISO = new Date(new Date(startISO).getTime() + d.durationMs).toISOString();
    onMove(d.id, room.id, startISO, endISO);
  }

  // Click an empty part of a column → start a 1-hour booking there.
  function onColumnClick(e: React.MouseEvent, room: Room) {
    const colTop = e.currentTarget.getBoundingClientRect().top;
    const startISO = tz.toUtcIso(dateStr, yToTime(e.clientY - colTop));
    const endISO = new Date(new Date(startISO).getTime() + 3_600_000).toISOString();
    onCreate(room.id, startISO, endISO);
  }

  if (!rooms.length) {
    return <div className="muted" style={{ padding: 24, textAlign: 'center' }}>No bookable rooms to show.</div>;
  }

  const TIME_COL = 56;
  const COL_MIN = 150;

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ minWidth: TIME_COL + rooms.length * COL_MIN, display: 'flex', flexDirection: 'column' }}>
        {/* Header row: room names */}
        <div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 3, background: 'var(--surface)' }}>
          <div style={{ width: TIME_COL, flex: '0 0 auto', borderBottom: '1px solid var(--border)' }} />
          {rooms.map((r) => (
            <div key={r.id} title={r.location ? `${r.name} · ${r.location}` : r.name}
              style={{
                flex: `1 1 ${COL_MIN}px`, minWidth: COL_MIN, padding: '8px 10px',
                borderLeft: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden',
                textOverflow: 'ellipsis', textAlign: 'center',
              }}>
              {r.name}
            </div>
          ))}
        </div>

        {/* Body: time gutter + one positioned column per room */}
        <div style={{ display: 'flex' }}>
          {/* Hour labels */}
          <div style={{ width: TIME_COL, flex: '0 0 auto', position: 'relative', height: bodyHeight }}>
            {hours.map((h, i) => (
              <div key={h} style={{
                position: 'absolute', top: i * HOUR_PX - 7, right: 6,
                fontSize: 11, color: 'var(--text-muted)',
              }}>{pad2(h)}:00</div>
            ))}
          </div>

          {/* Room columns */}
          {rooms.map((r) => (
            <div key={r.id}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
              onDrop={(e) => onColumnDrop(e, r)}
              onClick={(e) => onColumnClick(e, r)}
              style={{
                flex: `1 1 ${COL_MIN}px`, minWidth: COL_MIN, position: 'relative',
                height: bodyHeight, borderLeft: '1px solid var(--border)', cursor: 'copy',
                background: 'repeating-linear-gradient(var(--surface), var(--surface) ' +
                  `${HOUR_PX - 1}px, var(--border) ${HOUR_PX - 1}px, var(--border) ${HOUR_PX}px)`,
              }}>
              {(byRoom.get(r.id) || []).map(({ b, range }) => {
                const box = boxOf(range);
                const locked = !!b.subjectHidden;
                return (
                  <div key={b.id}
                    draggable={!locked}
                    onDragStart={(ev) => !locked && onBlockDragStart(ev, b)}
                    onClick={(ev) => { ev.stopPropagation(); if (!locked) onOpen(b.id); }}
                    title={locked ? 'Private booking' : `${minToHHMM(range.startMin)}–${minToHHMM(Math.min(range.endMin, 24 * 60))}  ${b.title || ''}`}
                    style={{
                      position: 'absolute', top: box.top, height: box.height,
                      left: 3, right: 3, overflow: 'hidden',
                      background: 'var(--surface)', color: 'var(--text)',
                      border: '1px solid var(--border)', borderLeft: `4px solid ${statusColor(b.status)}`,
                      borderRadius: 4, padding: '2px 6px', fontSize: 11,
                      cursor: locked ? 'not-allowed' : 'grab',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.08)', zIndex: 1,
                    }}>
                    <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {locked ? '🔒 Private' : (b.title || 'Booking')}
                    </div>
                    {box.height > 28 && (
                      <div style={{ color: 'var(--text-muted)' }}>{minToHHMM(range.startMin)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
