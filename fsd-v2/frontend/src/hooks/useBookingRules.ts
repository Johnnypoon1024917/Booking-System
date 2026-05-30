import { useMemo } from 'react';
import { useTenant } from '../stores/tenant';

// Port of v1's composables/bookingRules.js — admin-configured booking
// constraints (min/max duration, advance horizon, recurrence whitelist,
// weekend handling). Every booking entry point (calendar, search, modal)
// should call validate() before allowing submission so they all enforce
// the same rules the Settings screen persists.
export interface BookingRules {
  minMinutes: number;
  maxMinutes: number;
  horizonDays: number;
  weekendDays: number[];        // ISO weekday: Mon=1..Sun=7
  weekendRequireApproval: boolean;
  patterns: string[];           // recurrence patterns allowed (empty => all)
  blackoutDates: string[];      // YYYY-MM-DD strings
}

interface ValidateArgs {
  date?: string;     // YYYY-MM-DD
  start?: string;    // HH:MM
  end?: string;      // HH:MM
  startDate?: Date;
  endDate?: Date;
}

export function useBookingRules() {
  const customization = useTenant((s) => s.customization);

  const rules = useMemo<BookingRules>(() => {
    const c = customization || {};
    // Tolerate both snake_case (v1 Go API) and camelCase (v2 Nest API).
    return {
      minMinutes:           c.min_duration_minutes ?? c.minDurationMinutes ?? 15,
      maxMinutes:           c.max_duration_minutes ?? c.maxDurationMinutes ?? 480,
      horizonDays:          c.booking_horizon_days ?? c.bookingHorizonDays ?? 180,
      weekendDays:          c.weekend_days ?? c.weekendDays ?? [6, 7],
      weekendRequireApproval: !!(c.weekend_require_approval ?? c.weekendRequireApproval),
      patterns:             c.recurrence_patterns ?? c.recurrencePatterns ?? [],
      blackoutDates:        c.blackout_dates ?? c.blackoutDates ?? [],
    };
  }, [customization]);

  function allowsPattern(p: string): boolean {
    return !rules.patterns.length || rules.patterns.includes(p);
  }

  // Returns a human-readable reason the booking is rejected, or '' when
  // it satisfies every rule. Accepts either a YYYY-MM-DD + HH:MM pair or
  // pre-built Date objects.
  function validate({ date, start, end, startDate, endDate }: ValidateArgs): string {
    const s = startDate || (date && start ? new Date(`${date}T${start}`) : null);
    const e = endDate   || (date && end   ? new Date(`${date}T${end}`)   : null);
    if (!s || !e || isNaN(+s) || isNaN(+e)) return 'Invalid date or time.';
    if (e <= s) return 'End time must be after start time.';

    const mins = (+e - +s) / 60000;
    if (mins < rules.minMinutes) return `Minimum booking duration is ${rules.minMinutes} minutes.`;
    if (mins > rules.maxMinutes) {
      return `Maximum booking duration is ${Math.round(rules.maxMinutes / 60 * 10) / 10} hours.`;
    }

    const now = new Date();
    if (+s < now.getTime() - 60_000) return 'Booking start must be in the future.';

    const horizon = new Date(now);
    horizon.setDate(horizon.getDate() + rules.horizonDays);
    if (+s > +horizon) return `Bookings can only be made up to ${rules.horizonDays} days in advance.`;

    // Blackout dates apply to the start date (a meeting that crosses
    // midnight onto a blackout is still allowed if it started the day
    // before — matches v1 semantics).
    if (rules.blackoutDates.length) {
      const iso = s.toISOString().slice(0, 10);
      if (rules.blackoutDates.includes(iso)) return 'Selected date is a blackout / closed day.';
    }
    return '';
  }

  function isWeekend(d: Date): boolean {
    const day = d.getDay();                    // 0=Sun..6=Sat
    const iso = day === 0 ? 7 : day;           // 1=Mon..7=Sun
    return rules.weekendDays.includes(iso);
  }

  return { rules, allowsPattern, validate, isWeekend };
}
