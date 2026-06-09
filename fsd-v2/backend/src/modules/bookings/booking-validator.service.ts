import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Holiday } from '../holidays/holiday.entity';
import { CustomizationService } from '../customization/customization.service';
import { utcToZonedWallClock } from '../../common/tz';

// Server-side booking-rule enforcement for the tenant-wide policy knobs the
// SPA's useBookingRules hook validates client-side: past-date, advance
// horizon, min/max duration, blackout dates, and blocker holidays. Those
// client checks are trivially bypassed by calling the API directly, so the
// authoritative enforcement has to live here on the write path. Mirrors the
// field names the Settings screen persists into tenant_customizations and
// the v1 booking_validator.go contract.
//
// Per-resource operating-hours and restricted-access checks are enforced
// separately, inline in BookingsService (they need the transactional
// resource row); this service owns only the tenant-policy rules. Day-level
// rules (blackout / holiday) are evaluated against the start's *local*
// calendar date in the tenant's IANA timezone, never the server zone.
@Injectable()
export class BookingValidatorService {
  // A booking may start up to this many ms in the past before we reject it,
  // absorbing clock skew between the client clock and the API.
  private static readonly PAST_GRACE_MS = 60_000;

  constructor(
    @InjectRepository(Holiday) private readonly holidays: Repository<Holiday>,
    private readonly customization: CustomizationService,
  ) {}

  // Throws BadRequestException on the first rule a booking violates;
  // returns silently when the (start,end) window satisfies every rule for
  // the given resource. `now` is injectable for deterministic tests.
  //
  // `overrides` are the booked resource's per-resource rule overrides
  // (resource.ruleOverrides). When a key is present it wins over the tenant
  // customization default; when absent the tenant value (then the built-in
  // fallback) applies — so passing `undefined` reproduces the pure
  // tenant-wide behaviour exactly.
  async validate(
    tenantId: string, start: Date, end: Date, now: Date = new Date(),
    overrides?: {
      minDurationMinutes?: number;
      maxDurationMinutes?: number;
      bookingHorizonDays?: number;
    } | null,
    // Region of the booked resource. A holiday blocks the booking when it is
    // tenant-wide (region '') OR scoped to this resource's region. Pass
    // null/undefined for a resource with no region — only tenant-wide
    // closures apply then.
    resourceRegion?: string | null,
    // All-day bookings reserve the room for the whole day (or its full
    // operating-hours window). Their span legitimately exceeds the per-booking
    // min/max duration caps — a room open 09:00–18:00 is a 9-hour all-day
    // booking, past the 8-hour default — so those two duration rules are
    // skipped for them (QA #15). Every other rule (past-date, horizon,
    // blackout, holiday) still applies.
    isAllDay = false,
  ): Promise<void> {
    if (!(end > start)) throw new BadRequestException('end must be after start');

    const c = (await this.customization.get(tenantId)) as Record<string, any>;
    const tz: string = c.timezone || 'Asia/Hong_Kong';
    const minMinutes = num(overrides?.minDurationMinutes ?? c.min_duration_minutes ?? c.minDurationMinutes, 15);
    const maxMinutes = num(overrides?.maxDurationMinutes ?? c.max_duration_minutes ?? c.maxDurationMinutes, 480);
    const horizonDays = num(overrides?.bookingHorizonDays ?? c.booking_horizon_days ?? c.bookingHorizonDays, 180);
    const blackout: string[] = c.blackout_dates ?? c.blackoutDates ?? [];

    // Past / future-horizon. Both bound the *start* instant.
    if (+start < +now - BookingValidatorService.PAST_GRACE_MS) {
      throw new BadRequestException('booking start must be in the future');
    }
    const horizon = new Date(+now + horizonDays * 86400000);
    if (+start > +horizon) {
      throw new BadRequestException(`bookings can only be made up to ${horizonDays} days in advance`);
    }

    // Duration — skipped entirely for all-day bookings (they span the room's
    // whole open window by design, see isAllDay above).
    if (!isAllDay) {
      const mins = (+end - +start) / 60000;
      if (mins < minMinutes) {
        throw new BadRequestException(`minimum booking duration is ${minMinutes} minutes`);
      }
      if (mins > maxMinutes) {
        throw new BadRequestException(`maximum booking duration is ${Math.round(maxMinutes / 6) / 10} hours`);
      }
    }

    // Blackout + holiday: evaluated against EVERY local calendar date the
    // booking spans, not just the start. A multi-day booking (e.g. a Mon–Wed
    // workshop) must be rejected if ANY day it covers is a blackout day or a
    // blocker holiday — checking only the start date let a booking straddle a
    // closed Tuesday undetected. Dates are the local calendar days in the
    // tenant's timezone so a UTC+8 tenant doesn't trip the neighbouring day.
    const spannedDates = localDatesSpanned(start, end, tz);

    const blackoutHit = spannedDates.find((d) => blackout.includes(d));
    if (blackoutHit) {
      throw new BadRequestException(`selected dates include a blackout / closed day (${blackoutHit})`);
    }

    // Tenant-wide ('') plus this resource's region (if any). A row scoped to
    // a different region does not block this booking. One IN-query covers the
    // whole spanned range instead of a lookup per day.
    const regions = resourceRegion ? ['', resourceRegion] : [''];
    const holiday = await this.holidays.findOne({
      where: { tenantId, holidayDate: In(spannedDates), isBlocker: true, region: In(regions) },
    });
    if (holiday) {
      throw new BadRequestException(
        `selected dates include a closed holiday (${holiday.name || 'holiday'} on ${holiday.holidayDate})`,
      );
    }
  }
}

// Every local calendar date (YYYY-MM-DD, in `tz`) a booking touches, from its
// start day through its end day inclusive. An end landing exactly on local
// midnight belongs to the previous day (the booking doesn't actually occupy any
// of the new day), so it's excluded — otherwise an 09:00→24:00 booking would
// spuriously claim the next calendar day.
function localDatesSpanned(start: Date, end: Date, tz: string): string[] {
  const s = utcToZonedWallClock(start, tz);
  const e = utcToZonedWallClock(end, tz);
  // The end's effective last occupied day: if it lands exactly on midnight,
  // step back to the prior day.
  const endDateStr = e.minutes === 0 && e.dateStr !== s.dateStr
    ? addDaysToDateStr(e.dateStr, -1)
    : e.dateStr;

  const dates: string[] = [];
  let cur = s.dateStr;
  // Guard against pathological ranges; the duration cap above already bounds
  // sane bookings, but never loop unbounded on bad data.
  for (let i = 0; i < 366 && cur <= endDateStr; i++) {
    dates.push(cur);
    if (cur === endDateStr) break;
    cur = addDaysToDateStr(cur, 1);
  }
  return dates;
}

// Whole-day arithmetic on a YYYY-MM-DD string via UTC midnight (DST-independent
// — we're moving calendar dates, not instants).
function addDaysToDateStr(s: string, n: number): string {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86_400_000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
