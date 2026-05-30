import { useMemo } from 'react';
import { useTenant } from '../stores/tenant';
import { zonedWallTimeToUtcIso } from '../utils/datetime';

// Booking times are wall-clock in the *tenant's* timezone, but the SPA was
// rendering them with bare toLocale* calls — i.e. in the browser's zone, with
// no label. For a multi-region tenant that silently shows the wrong time and
// is the single highest-harm gap vs Outlook (which labels the zone on every
// event). This hook centralises the tenant zone + labelled formatters so every
// booking surface displays the same, explicitly-zoned time.

const DEFAULT_TZ = 'Asia/Hong_Kong';

// Short GMT offset label for a zone at a given instant, e.g. "GMT+8".
function offsetLabel(tz: string, at: Date): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'shortOffset', hour: '2-digit',
    }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value || tz;
  } catch {
    return tz;
  }
}

export function useTimezone() {
  const customization = useTenant((s) => s.customization);
  const tz: string = customization?.timezone || customization?.time_zone || DEFAULT_TZ;

  return useMemo(() => {
    const now = new Date();
    const offset = offsetLabel(tz, now);
    // e.g. "Asia/Hong_Kong (GMT+8)" — shown as a banner in booking forms.
    const label = `${tz.replace(/_/g, ' ')} (${offset})`;

    // Format an instant as a time in the tenant zone, with the offset suffix
    // so the user can never misread which zone a slot is in.
    const formatTime = (d: Date | string) => {
      const date = typeof d === 'string' ? new Date(d) : d;
      const t = new Intl.DateTimeFormat(undefined, {
        timeZone: tz, hour: '2-digit', minute: '2-digit',
      }).format(date);
      return `${t} ${offset}`;
    };

    const formatDateTime = (d: Date | string) => {
      const date = typeof d === 'string' ? new Date(d) : d;
      const s = new Intl.DateTimeFormat(undefined, {
        timeZone: tz, dateStyle: 'medium', timeStyle: 'short',
      }).format(date);
      return `${s} ${offset}`;
    };

    // Build a UTC ISO from a wall-clock date+time the user entered *in the
    // tenant zone* (not the browser zone). Use this for every booking write
    // so the stored instant matches the labelled "times shown in <zone>".
    const toUtcIso = (dateStr: string, timeStr: string) =>
      zonedWallTimeToUtcIso(dateStr, timeStr, tz);

    return { tz, offset, label, formatTime, formatDateTime, toUtcIso };
  }, [tz]);
}
