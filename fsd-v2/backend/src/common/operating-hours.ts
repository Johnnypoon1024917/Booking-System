import { BadRequestException } from '@nestjs/common';

// Per-resource operating hours.
//
// Production shape is a per-weekday schedule so a room can be open
// Mon–Fri 08:00–18:00, Sat 10:00–17:00, and closed Sunday. Weekday keys are
// "0"=Sun … "6"=Sat (matching JS getDay / tz.utcToZonedWallClock). A day mapped
// to a window is open then; a day mapped to null — or absent once `days` is
// present — is CLOSED. The legacy single-window shape ({ open, close } applied
// to every day) is still accepted on input and still read from old rows.
export interface DayWindow { open: string; close: string }
export interface OperatingHours {
  days?: Record<string, DayWindow | null>;
  // Legacy single window — preserved so pre-existing rows keep working.
  open?: string;
  close?: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function weekdayName(weekday: number): string {
  return WEEKDAY_NAMES[weekday] ?? String(weekday);
}

// hhmm → minutes since midnight, or null when malformed.
export function hhmmToMin(v: string | undefined | null): number | null {
  if (!v || !HHMM.test(v)) return null;
  const [h, m] = v.split(':').map(Number);
  return h * 60 + m;
}

// Resolve the open/close window that applies on `weekday` (0=Sun..6=Sat),
// or null when the resource is closed that day. Tolerates both the new
// per-day shape and the legacy single-window shape.
export function windowForWeekday(
  oh: OperatingHours | null | undefined, weekday: number,
): DayWindow | null {
  if (!oh) return null;
  if (oh.days) {
    const key = String(weekday);
    // Per-day mode: an explicit entry wins (window or null=closed); a day that
    // isn't listed at all is treated as closed.
    return Object.prototype.hasOwnProperty.call(oh.days, key) ? (oh.days[key] ?? null) : null;
  }
  if (oh.open && oh.close) return { open: oh.open, close: oh.close };
  return null;
}

// True when the schedule has at least one open day — used to distinguish
// "no restriction" (null) from "configured but every day closed".
export function hasAnyOpenDay(oh: OperatingHours | null | undefined): boolean {
  if (!oh) return false;
  if (oh.days) return Object.values(oh.days).some((w) => w && w.open && w.close);
  return !!(oh.open && oh.close);
}

// Validate + canonicalise operating hours coming from the API into the per-day
// shape, throwing BadRequestException on malformed input. Returns null when the
// schedule is effectively empty (→ open 24h / no restriction). Legacy
// { open, close } input is expanded to all seven days.
export function normalizeOperatingHours(raw: unknown): OperatingHours | null {
  if (raw == null) return null;
  if (typeof raw !== 'object') throw new BadRequestException('operatingHours must be an object');
  const input = raw as OperatingHours;

  const validateWindow = (w: DayWindow, label: string): DayWindow => {
    const open = hhmmToMin(w.open);
    const close = hhmmToMin(w.close);
    if (open == null) throw new BadRequestException(`${label}: open must be HH:mm`);
    if (close == null) throw new BadRequestException(`${label}: close must be HH:mm`);
    if (close <= open) throw new BadRequestException(`${label}: close must be after open`);
    return { open: w.open, close: w.close };
  };

  let source: Record<string, DayWindow | null> | undefined;
  if (input.days && typeof input.days === 'object') {
    source = input.days;
  } else if (input.open || input.close) {
    // Legacy single window → expand to every weekday.
    const win = validateWindow({ open: input.open!, close: input.close! }, 'operating hours');
    source = { 0: win, 1: win, 2: win, 3: win, 4: win, 5: win, 6: win };
  } else {
    return null;
  }

  const days: Record<string, DayWindow | null> = {};
  for (let wd = 0; wd < 7; wd++) {
    const key = String(wd);
    const entry = source[key];
    if (entry == null) {
      days[key] = null; // closed
    } else {
      days[key] = validateWindow(entry, weekdayName(wd));
    }
  }

  // Every day closed = no restriction would be more surprising than a hard
  // "always closed"; we still allow it so an admin can deliberately park a
  // room offline via hours, but collapse a literally-empty object to null.
  return { days };
}
