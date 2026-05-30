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

    // Duration.
    const mins = (+end - +start) / 60000;
    if (mins < minMinutes) {
      throw new BadRequestException(`minimum booking duration is ${minMinutes} minutes`);
    }
    if (mins > maxMinutes) {
      throw new BadRequestException(`maximum booking duration is ${Math.round(maxMinutes / 6) / 10} hours`);
    }

    // Blackout + holiday: evaluated against the start's *local* calendar
    // date so a tenant in UTC+8 doesn't trip the previous day's blackout.
    const local = utcToZonedWallClock(start, tz);
    if (blackout.includes(local.dateStr)) {
      throw new BadRequestException('selected date is a blackout / closed day');
    }
    // Tenant-wide ('') plus this resource's region (if any). A row scoped to
    // a different region does not block this booking.
    const regions = resourceRegion ? ['', resourceRegion] : [''];
    const holiday = await this.holidays.findOne({
      where: { tenantId, holidayDate: local.dateStr, isBlocker: true, region: In(regions) },
    });
    if (holiday) {
      throw new BadRequestException(`selected date is a closed holiday (${holiday.name || 'holiday'})`);
    }
  }
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
