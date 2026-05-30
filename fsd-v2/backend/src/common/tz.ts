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
