// Wall-clock ⇄ UTC helpers that are locked to a *specific* IANA timezone,
// not the browser's. The booking forms collect a date + HH:mm that the user
// reads as the tenant's local time (e.g. "09:00 in Hong Kong"). The naive
// `new Date(\`${date}T${time}:00\`)` parses that string in the *browser's*
// zone — so a user travelling in Tokyo booking a Hong-Kong room would shift
// the instant by the Tokyo↔HK offset and book the wrong slot (QA #1). These
// helpers compute the target zone's offset at the instant in question and
// subtract it, so the produced UTC ISO is always correct regardless of where
// the viewer's device is.

// Offset (ms) the zone is ahead of UTC at a given instant: i.e.
// wallClock(zone, instant) − instant. DST-aware because Intl resolves the
// actual rules for that instant.
function tzOffsetMs(timeZone: string, instant: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(instant))) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtc - instant;
}

// Convert a wall-clock date + time *in `timeZone`* to a UTC ISO string.
// `timeStr` accepts 'HH:mm' or 'HH:mm:ss'.
export function zonedWallTimeToUtcIso(dateStr: string, timeStr: string, timeZone: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi, s = 0] = timeStr.split(':').map(Number);
  // First guess: pretend the wall time is already UTC, then correct by the
  // zone offset at that instant. A second pass settles the rare case where
  // the guess and the true instant straddle a DST boundary (different offset).
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let utc = guess - tzOffsetMs(timeZone, guess);
  utc = guess - tzOffsetMs(timeZone, utc);
  return new Date(utc).toISOString();
}

// Weekday (0=Sun … 6=Sat) of a 'YYYY-MM-DD' calendar date. A calendar date
// has a single weekday independent of timezone, so we read it at noon-UTC to
// avoid the browser-local-midnight rollover that `new Date(dateStr)` risks.
export function weekdayOfDate(dateStr: string): number {
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, 12)).getUTCDay();
}
