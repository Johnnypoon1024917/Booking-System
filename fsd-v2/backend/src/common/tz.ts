// Timezone helpers shared across modules.
//
// The SPA sends search/booking windows as a date + wall-clock time (e.g.
// 2026-05-29 + "15:00"). Bookings, however, are persisted as true UTC
// instants (the client converts its local time via Date.toISOString()).
// If the API naively does `new Date(`${date}T${time}:00`)` it parses the
// wall clock in the *server* process timezone — typically UTC in a
// container — so a 15:00 Hong Kong search becomes 15:00Z and never overlaps
// a 15:00-local (07:00Z) booking. Booked rooms then look free (QA #1).
//
// zonedTimeToUtc reinterprets the wall clock in the tenant's IANA zone and
// returns the correct UTC instant, handling DST for that specific date.

const DEFAULT_TZ = 'Asia/Hong_Kong';

/**
 * Convert a wall-clock `date` (YYYY-MM-DD) + `time` (HH:mm) expressed in
 * `timeZone` into the equivalent UTC Date. Falls back to Asia/Hong_Kong and,
 * if the zone is unknown to the runtime, to a plain UTC interpretation.
 */
export function zonedTimeToUtc(date: string, time: string, timeZone?: string): Date {
  const tz = timeZone || DEFAULT_TZ;
  // First approximation: treat the wall clock as if it were already UTC.
  const asUtc = new Date(`${date}T${time}:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return new Date(`${date}T${time}:00`);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(asUtc).map((x) => [x.type, x.value]));
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    // The wall clock the zone *shows* for the `asUtc` instant.
    const shown = Date.UTC(
      Number(p.year), Number(p.month) - 1, Number(p.day),
      hour, Number(p.minute), Number(p.second),
    );
    // offset = shown - asUtc; the real instant for our intended wall clock is
    // asUtc shifted back by that offset.
    const offset = shown - asUtc.getTime();
    return new Date(asUtc.getTime() - offset);
  } catch {
    // Unknown timezone id — best effort: treat as UTC wall clock.
    return asUtc;
  }
}

/**
 * Project a UTC instant back to the wall clock shown in `timeZone`. Returns the
 * local weekday (0=Sun..6=Sat) and minutes-since-midnight, so booking-time code
 * can compare an instant against a resource's local operating-hours window
 * without re-deriving DST math. Falls back to Asia/Hong_Kong, then to a plain
 * UTC reading if the zone is unknown to the runtime.
 */
export function utcToZonedWallClock(
  instant: Date, timeZone?: string,
): { weekday: number; minutes: number; hhmm: string; dateStr: string } {
  const tz = timeZone || DEFAULT_TZ;
  const pad = (n: number) => String(n).padStart(2, '0');
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
    const p = Object.fromEntries(dtf.formatToParts(instant).map((x) => [x.type, x.value]));
    const hour = p.hour === '24' ? 0 : Number(p.hour);
    const minute = Number(p.minute);
    const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = WD[p.weekday as string] ?? instant.getUTCDay();
    const dateStr = `${p.year}-${p.month}-${p.day}`;
    return { weekday, minutes: hour * 60 + minute, hhmm: `${pad(hour)}:${pad(minute)}`, dateStr };
  } catch {
    const hour = instant.getUTCHours();
    const minute = instant.getUTCMinutes();
    const dateStr = `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}`;
    return { weekday: instant.getUTCDay(), minutes: hour * 60 + minute, hhmm: `${pad(hour)}:${pad(minute)}`, dateStr };
  }
}

/** Parse "HH:mm" into minutes-since-midnight, or null if malformed. */
export function hhmmToMinutes(v?: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
