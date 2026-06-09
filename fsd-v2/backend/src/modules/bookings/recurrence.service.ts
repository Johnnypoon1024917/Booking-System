import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from './booking.entity';
import { Resource } from '../resources/resource.entity';
import { Recurrence, RecurrencePattern } from './recurrence.entity';
import { BookingsService } from './bookings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AdminRoles, Role } from '../../common/decorators/roles.decorator';

// Caller-facing DTO for creating a recurring booking series. Matches
// v1's ExpandRecurringBookingRequest field-for-field so older clients
// can be ported across without renaming.
export interface CreateRecurringDto {
  resourceId: string;
  firstStart: string | Date;
  firstEnd: string | Date;
  pattern: RecurrencePattern;
  interval?: number;        // every N days/weeks/months (default 1)
  count?: number;           // total occurrences (1..100). Ignored if `until`.
  until?: string | Date;    // explicit end date; takes precedence over count
  byday?: number[];         // weekly: weekdays 0=Sun..6=Sat
  bymonth?: number[];       // monthly: month-days 1..31
  exDates?: (string | Date)[];
  title?: string;
  meetingUrl?: string;
  isPrivate?: boolean;
  rrule?: string;           // RFC 5545 raw string; takes precedence
  customFieldValues?: Record<string, unknown>;
  services?: string[];      // service add-ons applied to every occurrence
  costCenterCode?: string;  // chargeback code applied to every occurrence
}

export interface ExpansionResult {
  recurrenceId: string;
  bookingIds: string[];
  skipped: string[];        // ISO timestamps of occurrences that clashed
}

// MAX_OCCURRENCES mirrors v1's recurring_series cap. Beyond this we
// risk runaway insert storms (e.g. "every minute, count=10000").
const MAX_OCCURRENCES = 100;

// Hard ceiling on candidate-date iterations in the weekly/monthly expansion
// loops. Those loops walk forward week-by-week / month-by-month searching for
// `count` valid dates; an adversarial payload (e.g. COUNT=100 with an exDates /
// BYDAY combination that never resolves) could otherwise spin and block Node's
// single thread, freezing the whole backend (a one-request DoS). A legitimate
// series resolves in ~count iterations (≤100); this bound sits well above that.
const MAX_EXPANSION_ITERATIONS = 1000;

@Injectable()
export class RecurrenceService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    @InjectRepository(Recurrence) private readonly recurrences: Repository<Recurrence>,
    private readonly bookingsSvc: BookingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // Expand the request, save the parent Recurrence row, then insert
  // each occurrence. On per-occurrence conflict we skip (and report
  // back) rather than abort the whole series — matches v1 behaviour
  // and is friendlier than "all-or-nothing" for long horizons.
  async createSeries(tenantId: string, userId: string, dto: CreateRecurringDto): Promise<ExpansionResult> {
    const firstStart = new Date(dto.firstStart);
    const firstEnd = new Date(dto.firstEnd);
    if (isNaN(+firstStart) || isNaN(+firstEnd)) {
      throw new BadRequestException('firstStart/firstEnd must be ISO dates');
    }
    if (!(firstEnd > firstStart)) {
      throw new BadRequestException('end must be after start');
    }

    const resource = await this.resources.findOne({ where: { id: dto.resourceId, tenantId } });
    if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');

    const exDates = (dto.exDates || []).map((d) => +new Date(d));
    const occurrences = this.expand(dto, firstStart, firstEnd, exDates);
    if (occurrences.length === 0) {
      throw new BadRequestException('recurrence produced no occurrences');
    }

    const rec = await this.recurrences.save(this.recurrences.create({
      tenantId,
      createdBy: userId,
      resourceId: resource.id,
      pattern: dto.pattern,
      interval: dto.interval && dto.interval > 0 ? dto.interval : 1,
      count: dto.count,
      until: dto.until ? new Date(dto.until) : undefined,
      byday: dto.byday || [],
      bymonth: dto.bymonth || [],
      rrule: dto.rrule || '',
      status: 'Active',
    }));

    const result: ExpansionResult = { recurrenceId: rec.id, bookingIds: [], skipped: [] };

    let firstBooking: Booking | null = null;
    for (const occ of occurrences) {
      try {
        // suppressNotification: a series must not enqueue one email per
        // occurrence (a 100-occurrence weekly series = 100 emails). We send
        // a single summary email below instead. Per-occurrence calendar sync
        // and realtime still fire inside create().
        // Pass the recurrence id INTO create() so the occurrence is persisted,
        // emitted and synced as part of the series from its first write — a
        // post-create UPDATE would fire booking.created and the Outlook/Graph
        // outbox with recurrenceId still null, shipping N standalone meetings.
        const created = await this.bookingsSvc.create(tenantId, userId, {
          resourceId: resource.id,
          startTime: occ.start,
          endTime: occ.end,
          title: dto.title,
          meetingUrl: dto.meetingUrl,
          isPrivate: dto.isPrivate,
          customFieldValues: dto.customFieldValues,
          services: dto.services,
          costCenterCode: dto.costCenterCode,
          recurrenceId: rec.id,
          isRecurring: true,
        }, { suppressNotification: true });
        result.bookingIds.push(created.id);
        if (!firstBooking) firstBooking = created;
      } catch {
        // Conflict (or any creation failure) — record and continue.
        result.skipped.push(occ.start.toISOString());
      }
    }

    // Nothing materialised — every occurrence clashed or fell outside the
    // room's operating hours. Returning a 200 here made the SPA flash
    // "Recurring booking submitted" while "Booked 0 of N" — a success message
    // for a series that reserved nothing (QA #16). Delete the now-orphaned
    // parent row and fail loudly so the user knows no booking was made.
    if (result.bookingIds.length === 0) {
      await this.recurrences.delete({ id: rec.id, tenantId });
      throw new ConflictException(
        `none of the ${occurrences.length} occurrence(s) could be booked — each one conflicts with an existing booking or falls outside the room's operating hours`,
      );
    }

    // One summary email for the whole series, anchored on the first
    // occurrence. Fire-and-forget like the single-booking path; a mail
    // failure must never roll back the created series.
    if (firstBooking) {
      void this.notifications.enqueue(tenantId, 'BOOKING_CREATED', firstBooking);
    }
    return result;
  }

  // Cancel an entire recurring series.
  //
  // Authorization (AUD-008): only the series creator or an admin may cancel it.
  // The endpoint previously passed no caller identity, so any tenant user could
  // wipe out anyone's series.
  //
  // Side effects (AUD-008): each still-active occurrence is routed through the
  // normal BookingsService.cancel path instead of a single bulk UPDATE, so the
  // realtime `booking.cancelled` event, the calendar-sync outbox cancellation
  // (otherwise Outlook/Graph entries are orphaned), and the notification outbox
  // all fire per occurrence — exactly what the bulk UPDATE silently skipped.
  async cancelSeries(tenantId: string, userId: string, role: string, id: string, reason: string) {
    const rec = await this.recurrences.findOne({ where: { id, tenantId } });
    if (!rec) throw new NotFoundException('series not found');
    if (rec.createdBy !== userId && !AdminRoles.includes(role as Role)) {
      throw new ForbiddenException('not allowed to cancel this series');
    }
    rec.status = 'Cancelled';
    await this.recurrences.save(rec);

    const children = await this.bookings.find({ where: { tenantId, recurrenceId: id } });
    const settled = ['Cancelled', 'Checked In', 'No Show', 'Attended'];
    for (const child of children) {
      if (settled.includes(child.status)) continue;
      try {
        await this.bookingsSvc.cancel(tenantId, userId, role, child.id, reason || 'series cancelled');
      } catch {
        // Skip occurrences that became uncancellable (settled / changed
        // concurrently) rather than aborting the rest of the series.
      }
    }
    return rec;
  }

  // expand turns the request into a flat list of (start, end) occurrences.
  // The legacy pattern path mirrors v1's generateOccurrences. Custom
  // RRULE strings get a minimal parser that handles the subset we
  // actually emit (FREQ, INTERVAL, COUNT, UNTIL, BYDAY).
  private expand(
    dto: CreateRecurringDto, firstStart: Date, firstEnd: Date, exDates: number[],
  ): Array<{ start: Date; end: Date }> {
    if (dto.rrule && dto.rrule.trim()) {
      return this.expandRRule(dto.rrule, firstStart, firstEnd, exDates);
    }

    const interval = dto.interval && dto.interval > 0 ? dto.interval : 1;
    const until = dto.until ? new Date(dto.until) : undefined;
    // When the series is bounded by an end-date (no explicit count), generate
    // up to the MAX cap and let the `until` check below stop it — the SPA's
    // "Enable Repeating Schedule Pattern" sends an end-date with no count, and
    // the old `dto.count ?? 1` collapsed that to a SINGLE occurrence, so a
    // "weekly until 31 Jul" series silently materialised just the first date
    // (QA #16). With an explicit count we honour it (clamped to the cap).
    const count = dto.count
      ? Math.max(1, Math.min(dto.count, MAX_OCCURRENCES))
      : until ? MAX_OCCURRENCES : 1;
    const durMs = +firstEnd - +firstStart;
    const out: Array<{ start: Date; end: Date }> = [];

    const push = (s: Date) => {
      if (exDates.includes(+s)) return;
      if (until && s > until) return;
      out.push({ start: new Date(+s), end: new Date(+s + durMs) });
    };

    switch (dto.pattern) {
      case 'daily': {
        for (let i = 0; i < count; i++) {
          const s = addDays(firstStart, i * interval);
          push(s);
          if (until && s > until) break;
        }
        break;
      }
      case 'weekly': {
        const days = dto.byday && dto.byday.length ? [...dto.byday].sort() : [firstStart.getDay()];
        // Walk week-by-week, emitting one occurrence per byday in each
        // selected week, until we reach `count` or `until`.
        let weekStart = startOfWeek(firstStart);
        let emitted = 0;
        let guard = 0;
        while (emitted < count) {
          // Fail-safe: never let an unresolvable rule spin the event loop.
          if (guard++ > MAX_EXPANSION_ITERATIONS) {
            throw new BadRequestException('Recurrence rule is too restrictive or never resolves to a valid date.');
          }
          for (const wd of days) {
            const candidate = addDays(weekStart, wd);
            // Skip days before firstStart so we don't backfill the past.
            if (candidate < firstStart) continue;
            const s = new Date(candidate);
            s.setHours(firstStart.getHours(), firstStart.getMinutes(), 0, 0);
            if (until && s > until) { emitted = count; break; }
            push(s);
            emitted++;
            if (emitted >= count) break;
          }
          weekStart = addDays(weekStart, 7 * interval);
          if (out.length > MAX_OCCURRENCES) break;
        }
        break;
      }
      case 'bi-weekly': {
        for (let i = 0; i < count; i++) {
          push(addDays(firstStart, i * 14 * interval));
        }
        break;
      }
      case 'monthly': {
        const days = dto.bymonth && dto.bymonth.length ? dto.bymonth : [firstStart.getDate()];
        let emitted = 0;
        let monthOffset = 0;
        let guard = 0;
        while (emitted < count) {
          // Fail-safe: never let an unresolvable rule spin the event loop.
          if (guard++ > MAX_EXPANSION_ITERATIONS) {
            throw new BadRequestException('Recurrence rule is too restrictive or never resolves to a valid date.');
          }
          for (const dom of days) {
            const s = new Date(firstStart);
            // Step to the target month WITHOUT letting an out-of-range day
            // silently roll forward. JS Date does: (Jan 31).setMonth(1) → Mar 3
            // because Feb 31 doesn't exist, so an "end of month" series would
            // bounce between the 28th/30th/31st and the 2nd/3rd. Pin to the 1st
            // first (setMonth with day=1 can't overflow), then snap the
            // requested day-of-month down to the days that month actually has.
            s.setMonth(s.getMonth() + monthOffset * interval, 1);
            const maxDom = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate();
            s.setDate(Math.min(dom, maxDom));
            if (s < firstStart) continue;
            if (until && s > until) { emitted = count; break; }
            push(s);
            emitted++;
            if (emitted >= count) break;
          }
          monthOffset++;
          if (out.length > MAX_OCCURRENCES) break;
        }
        break;
      }
      case 'custom':
        // Custom without an RRULE = just the first occurrence.
        push(firstStart);
        break;
    }

    return out.slice(0, MAX_OCCURRENCES);
  }

  // expandRRule handles the slice of RFC 5545 we actually emit:
  // FREQ=DAILY|WEEKLY|MONTHLY, INTERVAL, COUNT, UNTIL, BYDAY=MO,TU,...
  private expandRRule(
    rrule: string, firstStart: Date, firstEnd: Date, exDates: number[],
  ): Array<{ start: Date; end: Date }> {
    const parts: Record<string, string> = {};
    for (const p of rrule.replace(/^RRULE:/i, '').split(';')) {
      const [k, v] = p.split('=');
      if (k && v) parts[k.toUpperCase()] = v;
    }
    const freq = (parts.FREQ || 'DAILY').toUpperCase();
    const interval = Math.max(1, parseInt(parts.INTERVAL || '1', 10));
    const count = Math.min(parseInt(parts.COUNT || '0', 10) || MAX_OCCURRENCES, MAX_OCCURRENCES);
    const until = parts.UNTIL ? parseUntil(parts.UNTIL) : undefined;
    const byday = parts.BYDAY
      ? parts.BYDAY.split(',').map((d) => weekdayCode(d)).filter((d) => d >= 0)
      : [];

    const dto: CreateRecurringDto = {
      resourceId: '',
      firstStart,
      firstEnd,
      pattern: (freq === 'WEEKLY' ? 'weekly' : freq === 'MONTHLY' ? 'monthly' : 'daily'),
      interval,
      count,
      until,
      byday,
    };
    // Re-dispatch through the pattern path so we get one expansion code path.
    return this.expand(dto, firstStart, firstEnd, exDates);
  }
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}
function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setDate(out.getDate() - out.getDay());
  out.setHours(0, 0, 0, 0);
  return out;
}
function weekdayCode(s: string): number {
  return ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(s.toUpperCase());
}
function parseUntil(s: string): Date {
  // RFC 5545 UNTIL is either YYYYMMDD or YYYYMMDDTHHMMSSZ.
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/);
  if (!m) return new Date(s);
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +(hh || 0), +(mm || 0), +(ss || 0)));
}
