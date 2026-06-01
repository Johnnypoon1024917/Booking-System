import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository } from 'typeorm';
import { Booking } from './booking.entity';
import { Resource } from '../resources/resource.entity';
import { User } from '../users/user.entity';
import { AdminRoles, Role } from '../../common/decorators/roles.decorator';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SyncOutboxService } from '../sync-outbox/sync-outbox.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CustomizationService } from '../customization/customization.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { BookingValidatorService } from './booking-validator.service';
import { utcToZonedWallClock, zonedTimeToUtc, hhmmToMinutes } from '../../common/tz';
import { windowForWeekday, weekdayName } from '../../common/operating-hours';

// Terminal booking states are settled — their time window can no longer be
// rescheduled, and they can't be cancelled again. Guards reschedule/cancel
// against a Cancelled / No Show / Checked In / Attended booking. 'Attended' is
// a post-hoc admin confirmation that the meeting happened (checkin.service):
// once verified, the historical booking must be immutable like the others, or
// a user could edit/reschedule/cancel a meeting an admin already signed off.
const TERMINAL_STATUSES: ReadonlyArray<string> = ['Cancelled', 'No Show', 'Checked In', 'Attended'];

export interface CreateBookingDto {
  resourceId: string;
  startTime: string | Date;
  endTime: string | Date;
  title?: string;
  meetingUrl?: string;
  isPrivate?: boolean;
  customFieldValues?: Record<string, unknown>;
  // Service add-ons (Catering, IT setup, …) requested for the booking.
  services?: string[];
  // Chargeback / cost-center code to bill this booking against. Validated
  // against the tenant's configured list (customization.cost_centers).
  costCenterCode?: string;
  // Recurrence linkage, set by RecurrenceService when expanding a series so the
  // occurrence is BORN linked — the booking.created event and calendar-sync
  // outbox entry then carry the recurrenceId from the first emit, instead of a
  // post-create UPDATE racing the websocket/Graph push and shipping standalone
  // meetings that get re-linked a moment later.
  recurrenceId?: string;
  isRecurring?: boolean;
}
export interface UpdateBookingDto {
  startTime?: string | Date;
  endTime?: string | Date;
  meetingUrl?: string;
  title?: string;
  resourceId?: string;   // move the booking to a different room
  // Service add-ons (Catering, IT setup, …) — editable post-creation. An empty
  // array clears them; undefined leaves the stored list untouched.
  services?: string[];
  // Custom-field answers — merged over the stored values and re-validated.
  customFieldValues?: Record<string, unknown>;
}

@Injectable()
export class BookingsService {
  private readonly log = new Logger(BookingsService.name);

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly realtime: RealtimeGateway,
    private readonly syncOutbox: SyncOutboxService,
    private readonly notifications: NotificationsService,
    private readonly customization: CustomizationService,
    // forwardRef: ApprovalsModule imports BookingsModule, so the two modules
    // reference each other. The chain is materialized from the booking write
    // path (so an approval-requiring booking gets its configured steps), and
    // the create response carries the first pending approver back to the SPA.
    @Inject(forwardRef(() => ApprovalsService))
    private readonly approvals: ApprovalsService,
    private readonly validator: BookingValidatorService,
  ) {}

  // Enqueue the calendar push onto the durable sync outbox rather than firing
  // it inline. Calendar push failures must never block the primary booking
  // write (the DB is the source of truth), AND a transient provider outage
  // must not silently drop the event — the outbox worker retries with backoff.
  private dispatchSync(eventName: string, tenantId: string, bookingId: string) {
    void this.syncOutbox.enqueue(eventName, tenantId, bookingId);
  }

  async listMine(tenantId: string, userId: string) {
    const rows = await this.bookings.find({
      where: { tenantId, userId },
      order: { startTime: 'DESC' },
      take: 200,
    });
    return this.withResourceNames(tenantId, rows);
  }

  async listAllForRange(
    tenantId: string, start: Date, end: Date, viewerId: string, viewerRole: string,
  ) {
    const rows = await this.bookings
      .createQueryBuilder('b')
      .where('b.tenant_id = :t', { t: tenantId })
      .andWhere('b.start_time >= :s AND b.start_time < :e', { s: start, e: end })
      .orderBy('b.start_time', 'ASC')
      .getMany();
    const named = await this.withResourceNames(tenantId, rows);
    return this.projectForViewer(named, viewerId, viewerRole);
  }

  // projectForViewer redacts private bookings the caller isn't entitled to
  // see, mirroring the Go stack's visibility.ProjectBooking. The owner and
  // a System Admin (audit backstop) always see full detail; for everyone
  // else a booking flagged is_private has its subject and links stripped and
  // replaced with a "Reserved" placeholder. We keep the time/room/status and
  // set subjectHidden:true so the calendar can render a blurred "Private"
  // block without ever receiving the real subject. user_id is dropped too so
  // viewers can't infer the owner of a private slot.
  private projectForViewer<T extends Booking & { resourceName?: string }>(
    rows: T[], viewerId: string, viewerRole: string,
  ): Array<T & { subjectHidden?: boolean }> {
    const privileged = viewerRole === 'System Admin';
    return rows.map((b) => {
      if (!b.isPrivate || b.userId === viewerId || privileged) return b;
      return {
        ...b,
        userId: '',
        title: 'Reserved',
        meetingUrl: '',
        redirectUrl: '',
        exceptionNotes: '',
        checkinToken: undefined,
        subjectHidden: true,
      };
    });
  }

  // Denormalise the human-readable resource name onto each booking so the
  // SPA never has to render a raw resource UUID as the heading — a caller
  // who cannot enumerate the full resource catalogue (e.g. an officer)
  // otherwise has no way to resolve the name client-side (QA #7). The
  // resource name is not PII; the resourceId is already exposed.
  private async withResourceNames(tenantId: string, rows: Booking[]) {
    if (!rows.length) return rows;
    const ids = [...new Set(rows.map((b) => b.resourceId))];
    const resources = await this.resources.find({ where: { tenantId, id: In(ids) } });
    const nameById = new Map(resources.map((r) => [r.id, r.name]));
    return rows.map((b) => ({ ...b, resourceName: nameById.get(b.resourceId) || '' }));
  }

  async get(tenantId: string, id: string) {
    const b = await this.bookings.findOne({ where: { id, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    return b;
  }

  // opts.suppressNotification skips the per-booking email enqueue. The
  // recurring-series path sets it so a 100-occurrence series sends ONE
  // summary email instead of flooding the owner's inbox with 100 — calendar
  // sync and realtime still fire per occurrence (each event must reach
  // Outlook/Google and the live calendar).
  async create(
    tenantId: string, userId: string, dto: CreateBookingDto,
    opts: { suppressNotification?: boolean } = {},
  ) {
    let start = new Date(dto.startTime);
    let end = new Date(dto.endTime);
    if (!(end > start)) throw new ConflictException('end must be after start');

    const resource = await this.resources.findOne({ where: { id: dto.resourceId, tenantId } });
    if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');

    // An "All Day" request arrives as the whole local day (00:00 → 23:59). For a
    // room with operating hours that always overruns the close time, so map it
    // onto the day's actual open/close window instead of letting it be rejected
    // (see mapAllDayToOperatingHours).
    ({ start, end } = await this.mapAllDayToOperatingHours(tenantId, resource, start, end));

    await this.assertCanBook(tenantId, userId, resource);
    // Tenant-policy rules (past-date, horizon, duration, blackout, holiday),
    // with the resource's per-resource overrides layered on top (a room may
    // cap duration tighter — or loosen the horizon — vs the tenant default).
    // Authoritative server-side mirror of the SPA's useBookingRules.
    await this.validator.validate(tenantId, start, end, new Date(), resource.ruleOverrides ?? undefined, resource.region ?? null);
    await this.assertWithinOperatingHours(tenantId, resource, start, end);
    const customFieldValues = this.validateCustomFields(resource, dto.customFieldValues);
    const costCenterCode = await this.resolveCostCenter(tenantId, dto.costCenterCode, resource);

    // Conflict check + insert run in one transaction holding a row-level lock
    // on the resource (and its composite relatives). Without this the SELECT
    // (assertNoConflict) and the INSERT race: two concurrent requests both see
    // no clash and both commit, double-booking the room. This schema is
    // synchronize-only with no EXCLUDE constraint, so the application lock is
    // the *only* backstop — mirrors v1's LockResourceForUpdate fix.
    const saved = await this.bookings.manager.transaction(async (m) => {
      const ids = await this.relatedResourceIds(m, tenantId, resource);
      await this.lockResources(m, tenantId, ids);
      await this.assertNoConflict(m, tenantId, ids, start, end, null, resource);
      const b = m.getRepository(Booking).create({
        tenantId, resourceId: resource.id, userId,
        startTime: start, endTime: end,
        title: dto.title || '',
        meetingUrl: dto.meetingUrl || '',
        isPrivate: !!dto.isPrivate,
        customFieldValues: Object.keys(customFieldValues).length ? customFieldValues : null,
        services: dto.services && dto.services.length ? dto.services : null,
        costCenterCode,
        // Born linked when expanding a series (see CreateBookingDto.recurrenceId).
        recurrenceId: dto.recurrenceId ?? undefined,
        isRecurring: dto.recurrenceId ? true : !!dto.isRecurring,
        // A per-resource override wins over the resource's own flag: `?? `
        // falls through only when the override key is absent, so a room can
        // explicitly waive (false) or force (true) approval regardless of the
        // base requiresApproval value.
        status: (resource.ruleOverrides?.requiresApproval ?? resource.requiresApproval) ? 'Pending Approval' : 'Confirmed',
      });
      return m.getRepository(Booking).save(b);
    });

    // Side-effects run only after the transaction commits, so a rolled-back
    // booking never emits a realtime/calendar/notification event.
    this.realtime.emit({
      type: 'booking.created',
      tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId,
    });
    this.dispatchSync('BOOKING_CREATED', tenantId, saved.id);
    // Pending-approval bookings still notify the owner that the request was
    // received; the event name drives which template the outbox renders.
    if (!opts.suppressNotification) {
      void this.notifications.enqueue(tenantId, 'BOOKING_CREATED', saved);
    }

    // Materialize the approval chain for a booking that needs approval, then
    // hand the requester the first pending step so the SPA can answer "who is
    // my approver?" right after booking (instead of a bare "Pending"). Only
    // runs for Pending-Approval bookings: a Confirmed booking never grows a
    // chain. Best-effort — a chain/lookup failure must not fail the create
    // (the booking is already committed; it just falls back to the legacy
    // single-level approval path with no surfaced approver).
    const result = saved as Booking & {
      requiresApproval?: boolean; approvalChain?: unknown[]; firstApprover?: unknown;
    };
    if (saved.status === 'Pending Approval') {
      result.requiresApproval = true;
      try {
        await this.approvals.materialize(saved);
        result.approvalChain = await this.approvals.listChain(tenantId, saved.id);
        result.firstApprover = await this.approvals.firstPendingApprover(tenantId, saved.id);
      } catch (e) {
        this.log.warn(`approval chain setup failed for booking ${saved.id}: ${(e as Error).message}`);
      }
    }
    return result;
  }

  // Re-queue a booking whose calendar push permanently failed (MyBookings
  // "retry to Outlook"). Owner or admin only. Returns the new sync state so the
  // SPA can optimistically flip the badge to 'pending'.
  async retrySync(tenantId: string, userId: string, role: string, id: string) {
    const b = await this.get(tenantId, id);
    if (b.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();
    const event = b.status === 'Cancelled' ? 'BOOKING_CANCELLED' : 'BOOKING_UPDATED';
    await this.syncOutbox.retry(tenantId, id, event);
    return { id, syncStatus: 'pending' as const };
  }

  async update(tenantId: string, userId: string, role: string, id: string, dto: UpdateBookingDto) {
    // Authz, conflict re-check and save all run in one transaction (the
    // transactional core is applyUpdate). When the time changes we lock the
    // resource so the re-check + save can't race a concurrent booking — the same
    // TOCTOU fix as create().
    const saved = await this.bookings.manager.transaction(
      (m) => this.applyUpdate(m, tenantId, userId, role, id, dto),
    );

    this.realtime.emit({
      type: 'booking.rescheduled',
      tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId: saved.userId,
    });
    this.dispatchSync('BOOKING_UPDATED', tenantId, saved.id);
    void this.notifications.enqueue(tenantId, 'BOOKING_UPDATED', saved);
    return saved;
  }

  // applyUpdate is the transactional core of one booking edit: re-fetch under
  // the row lock, authz, conflict re-check, mutate, save. It runs on a
  // caller-supplied EntityManager so the same logic serves two callers —
  // update() wraps it in its own transaction, while updateSeries() runs it for
  // every occurrence inside ONE shared transaction instead of opening a fresh
  // transaction + lock + commit per occurrence (which, for a 2-year weekly
  // series, meant ~100 sequential transactions and a likely gateway timeout /
  // pool exhaustion). Emits no side-effects — the caller fires those after the
  // surrounding transaction commits.
  private async applyUpdate(
    m: EntityManager, tenantId: string, userId: string, role: string,
    id: string, dto: UpdateBookingDto,
  ): Promise<Booking> {
    const timeChanged = !!(dto.startTime || dto.endTime);
    const b = await m.getRepository(Booking).findOne({ where: { id, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    // Owner OR admin can edit. Mirrors v1's update_booking.go check.
    if (b.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();
    // A settled booking (cancelled / no-show / checked-in) can't be edited.
    // Without this guard a reschedule silently mutated a Cancelled row's
    // window (and re-ran the conflict check) while leaving it Cancelled.
    if (TERMINAL_STATUSES.includes(b.status)) {
      throw new ConflictException(`cannot modify a ${b.status} booking`);
    }

    // A room move re-runs the same resource validation + conflict check the
    // time path does (against the new room), even when the time is unchanged.
    const targetResourceId = dto.resourceId || b.resourceId;
    const resourceChanged = targetResourceId !== b.resourceId;

    if (timeChanged || resourceChanged) {
      let start = dto.startTime ? new Date(dto.startTime) : b.startTime;
      let end = dto.endTime ? new Date(dto.endTime) : b.endTime;
      if (!(end > start)) throw new ConflictException('end must be after start');
      const resource = await m.getRepository(Resource).findOne({ where: { id: targetResourceId, tenantId } });
      // Parity with create(): a missing or inactive resource is not
      // bookable. Previously `if (resource)` let a reschedule onto a
      // deleted/deactivated resource through with NO conflict check at all.
      if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');
      // Same All-Day → operating-hours mapping create() applies, so editing a
      // booking to span the whole day lands inside the room's window too.
      ({ start, end } = await this.mapAllDayToOperatingHours(tenantId, resource, start, end));
      await this.validator.validate(tenantId, start, end, new Date(), resource.ruleOverrides ?? undefined, resource.region ?? null);
      await this.assertWithinOperatingHours(tenantId, resource, start, end);
      const ids = await this.relatedResourceIds(m, tenantId, resource);
      await this.lockResources(m, tenantId, ids);
      await this.assertNoConflict(m, tenantId, ids, start, end, id, resource);
      // If the resource requires approval (per its override, else its own
      // flag), a reschedule/move re-enters the approval queue rather than
      // silently staying Confirmed.
      if ((resource.ruleOverrides?.requiresApproval ?? resource.requiresApproval) && b.status === 'Confirmed') {
        b.status = 'Pending Approval';
      }
      b.startTime = start;
      b.endTime = end;
      b.resourceId = resource.id;
    }
    if (dto.title !== undefined) b.title = dto.title;
    if (dto.meetingUrl !== undefined) b.meetingUrl = dto.meetingUrl;
    // Service add-ons are editable after creation (Outlook parity) — adding
    // Catering later shouldn't force a cancel-and-rebook. An explicit empty
    // array clears them; an absent field leaves the stored list alone.
    if (dto.services !== undefined) {
      b.services = dto.services.length ? dto.services : null;
    }
    // Custom-field answers: merge the incoming changes over what's stored,
    // then re-validate against the resource so required fields stay enforced
    // and unknown keys are dropped (mirrors create()). Validated against the
    // booking's CURRENT resource (b.resourceId already reflects a room move).
    if (dto.customFieldValues !== undefined) {
      const resource = await m.getRepository(Resource).findOne({ where: { id: b.resourceId, tenantId } });
      const merged = { ...(b.customFieldValues || {}), ...dto.customFieldValues };
      const cleaned = resource ? this.validateCustomFields(resource, merged) : merged;
      b.customFieldValues = Object.keys(cleaned).length ? cleaned : null;
    }
    b.version += 1;
    return m.getRepository(Booking).save(b);
  }

  // updateSeries applies an edit to the whole recurring series an instance
  // belongs to ("edit series"). Each future, non-settled occurrence is shifted
  // to the same LOCAL wall-clock the edited instance moved to (preserving the
  // tenant-timezone time-of-day, plus any whole-day move); title, meeting URL
  // and room changes propagate to all. Every occurrence runs through the same
  // applyUpdate core (identical validation, locking and conflict re-check) — but
  // all of them share ONE transaction rather than opening one per occurrence, so
  // a 100-instance series is a single commit instead of 100 (the old loop over
  // update() risked a 5–15s run, a 504, and connection-pool exhaustion). A clash
  // on one occurrence is skipped and reported rather than aborting the batch
  // (mirrors createSeries). Past and settled occurrences are left untouched,
  // matching Outlook.
  async updateSeries(
    tenantId: string, userId: string, role: string, id: string, dto: UpdateBookingDto,
  ): Promise<{ updated: number; skipped: string[] }> {
    const anchor = await this.get(tenantId, id);
    if (anchor.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();

    // Not part of a series — fall back to a plain single update.
    if (!anchor.recurrenceId) {
      await this.update(tenantId, userId, role, id, dto);
      return { updated: 1, skipped: [] };
    }

    // A series time-shift must be computed in WALL-CLOCK terms, not as a raw
    // millisecond delta. A 9:00→10:00 move is "+1h of local clock time"; the
    // pure-UTC `+new Date()` math the old code used adds a fixed offset that
    // drifts to 9:00 or 11:00 for occurrences on the far side of a DST boundary
    // (the local offset changed but the millisecond delta didn't). We instead
    // capture the anchor's new local time-of-day + whole-day move, then re-encode
    // each occurrence through the tenant zone so every instance lands on the same
    // wall clock regardless of DST.
    const cust = await this.customization.get(tenantId);
    const tz = (cust as { timezone?: string }).timezone;
    const startShift = dto.startTime ? wallShift(anchor.startTime, new Date(dto.startTime), tz) : null;
    const endShift = dto.endTime ? wallShift(anchor.endTime, new Date(dto.endTime), tz) : null;
    const timeShift = !!(startShift || endShift);
    const now = new Date();

    const siblings = await this.bookings.find({
      where: { tenantId, recurrenceId: anchor.recurrenceId },
      order: { startTime: 'ASC' },
    });

    const result = { updated: 0, skipped: [] as string[] };
    const updatedBookings: Booking[] = [];

    // One transaction for the whole series. applyUpdate runs per occurrence on
    // the SAME EntityManager, so each resource lock is taken once, the conflict
    // re-checks are fast in-transaction SELECTs, and we commit a single time. A
    // per-occurrence clash throws an app-level exception *after* its SQL has
    // succeeded, so catching it leaves the transaction healthy for the rest.
    await this.bookings.manager.transaction(async (m) => {
      for (const s of siblings) {
        // Future, editable occurrences only.
        if (TERMINAL_STATUSES.includes(s.status)) continue;
        if (s.startTime < now) continue;

        const patch: UpdateBookingDto = {};
        if (dto.title !== undefined) patch.title = dto.title;
        if (dto.meetingUrl !== undefined) patch.meetingUrl = dto.meetingUrl;
        if (dto.resourceId) patch.resourceId = dto.resourceId;
        // Service add-ons and custom-field answers propagate to every occurrence.
        if (dto.services !== undefined) patch.services = dto.services;
        if (dto.customFieldValues !== undefined) patch.customFieldValues = dto.customFieldValues;
        if (timeShift) {
          if (startShift) patch.startTime = applyWallShift(s.startTime, startShift, tz);
          if (endShift) patch.endTime = applyWallShift(s.endTime, endShift, tz);
        }
        try {
          const saved = await this.applyUpdate(m, tenantId, userId, role, s.id, patch);
          updatedBookings.push(saved);
          result.updated++;
        } catch {
          // Conflict / rule violation on this occurrence — skip and report.
          result.skipped.push(s.startTime.toISOString());
        }
      }
    });

    // Side-effects fire only after the single commit, mirroring update(): a
    // rolled-back occurrence never emits a realtime/calendar/notification event.
    for (const saved of updatedBookings) {
      this.realtime.emit({
        type: 'booking.rescheduled',
        tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId: saved.userId,
      });
      this.dispatchSync('BOOKING_UPDATED', tenantId, saved.id);
      void this.notifications.enqueue(tenantId, 'BOOKING_UPDATED', saved);
    }
    return result;
  }

  async cancel(tenantId: string, userId: string, role: string, id: string, reason: string) {
    const b = await this.get(tenantId, id);
    if (b.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();
    // Idempotent: cancelling an already-cancelled booking is a no-op rather
    // than re-emitting events / notifications. A checked-in or no-show
    // booking is settled and can't be cancelled.
    if (b.status === 'Cancelled') return b;
    if (b.status === 'No Show' || b.status === 'Checked In' || b.status === 'Attended') {
      throw new ConflictException(`cannot cancel a ${b.status} booking`);
    }
    b.status = 'Cancelled';
    b.exceptionNotes = reason || 'cancelled';
    const saved = await this.bookings.save(b);
    this.realtime.emit({
      type: 'booking.cancelled',
      tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId: saved.userId,
      payload: { reason: b.exceptionNotes },
    });
    this.dispatchSync('BOOKING_CANCELLED', tenantId, saved.id);
    void this.notifications.enqueue(tenantId, 'BOOKING_CANCELLED', saved);
    return saved;
  }

  private isAdmin(role: string) {
    return ['System Admin', 'Security Admin', 'Room Admin', 'Secretary'].includes(role);
  }

  // lockResources takes a row-level FOR UPDATE lock (pessimistic_write) on the
  // given resource rows, in a deterministic id order so two overlapping
  // bookings can't deadlock by grabbing the same rows in opposite orders. Held
  // until the surrounding transaction commits, it serializes the
  // conflict-check + insert for those resources. Must be called inside a
  // transaction — `m` is the transactional EntityManager.
  private async lockResources(m: EntityManager, tenantId: string, ids: string[]) {
    if (!ids.length) return;
    await m.getRepository(Resource).createQueryBuilder('r')
      .setLock('pessimistic_write')
      .where('r.tenant_id = :t', { t: tenantId })
      .andWhere('r.id IN (:...ids)', { ids })
      .orderBy('r.id', 'ASC')
      .getMany();
  }

  // Conflict detection. For a standalone room we check that room only;
  // for parent/child (split spaces) we also block siblings. Uses
  // tstzrange overlap (&&) the same way v1's EXCLUDE constraint does. Runs
  // through the supplied EntityManager so it sees the transaction's locks.
  //
  // Pods (bookingMode='shared'): the resource tolerates up to sharedCapacity
  // concurrent bookings, so instead of "any overlap = clash" we count the
  // overlapping bookings and only reject once the pod is full. Composite
  // (parent/child) spaces are always exclusive — pods don't combine with
  // sub-rooms — so this only relaxes the single-resource case.
  private async assertNoConflict(
    m: EntityManager, tenantId: string, ids: string[], start: Date, end: Date,
    excludeBookingId: string | null, resource?: Resource,
  ) {
    const isPod = resource?.bookingMode === 'shared'
      && resource.compositeMode !== 'parent' && resource.compositeMode !== 'child';

    const qb = m.getRepository(Booking).createQueryBuilder('b')
      .where('b.tenant_id = :t', { t: tenantId })
      .andWhere('b.resource_id IN (:...ids)', { ids })
      .andWhere(`b.status NOT IN ('Cancelled','No Show')`)
      .andWhere(
        `tstzrange(b.start_time, b.end_time, '[)') && tstzrange(:s, :e, '[)')`,
        { s: start, e: end },
      );
    if (excludeBookingId) qb.andWhere('b.id != :ex', { ex: excludeBookingId });

    if (isPod) {
      const capacity = Math.max(1, resource?.sharedCapacity ?? 1);
      const overlapping = await qb.getCount();
      if (overlapping >= capacity) {
        throw new ConflictException(`all ${capacity} pods are booked for this slot`);
      }
      return;
    }

    const clash = await qb.getOne();
    if (clash) throw new ConflictException('time conflict — slot already booked');
  }

  // Reject bookings that fall outside the resource's local operating hours.
  // null/absent operatingHours = open 24h (no restriction). Hours are a
  // per-weekday schedule (Mon–Fri 08:00–18:00, Sat 10:00–17:00, Sun closed,
  // etc.) evaluated in the tenant's timezone, so we project the booking's UTC
  // instants back to local time and resolve the window for the booking's local
  // weekday. A booking on a closed day, or one that falls outside that day's
  // window, is rejected. The window is selected by the booking's *start* day.
  private async assertWithinOperatingHours(
    tenantId: string, resource: Resource, start: Date, end: Date,
  ) {
    const oh = resource.operatingHours;
    if (!oh) return;

    const cust = await this.customization.get(tenantId);
    const tz = (cust as { timezone?: string }).timezone;
    const s = utcToZonedWallClock(start, tz);
    const e = utcToZonedWallClock(end, tz);

    const win = windowForWeekday(oh, s.weekday);
    if (!win) {
      throw new ConflictException(`${resource.name} is closed on ${weekdayName(s.weekday)}`);
    }
    const open = hhmmToMinutes(win.open);
    const close = hhmmToMinutes(win.close);
    if (open == null || close == null || close <= open) return; // misconfigured — don't block

    // A booking under operating hours must lie wholly within a single local
    // day's open window. If it crosses into another calendar day the building
    // physically closed in between — reject the overnight span rather than only
    // checking the first day's start and the last day's end (the "overnight
    // camping" loophole: Mon 17:00 → Tue 09:00 passed both edge checks while the
    // room was closed all night). A booking ending exactly at the next local
    // midnight is the one boundary case that *could* legitimately mean "up to
    // close", but a daily-closing room can't be open at midnight, so we treat
    // any day-crossing booking as outside hours.
    if (e.dateStr !== s.dateStr) {
      throw new ConflictException(
        `${resource.name} closes daily — a booking can't run past ${win.close} into the next day`,
      );
    }

    if (s.minutes < open || e.minutes > close) {
      throw new ConflictException(
        `outside ${weekdayName(s.weekday)} operating hours (${win.open}–${win.close})`,
      );
    }
  }

  // Map an "All Day" booking onto the resource's actual operating-hours window.
  // The SPA sends an all-day request as the full local day (local 00:00 →
  // 23:59). For a room with operating hours that window always exceeds the
  // close time, so assertWithinOperatingHours would reject EVERY all-day booking
  // (23:59 > 18:00). Instead we detect the whole-day span and clamp it to the
  // day's open/close, so "All Day" books the room for exactly the hours it's
  // open. Rooms with no operating hours (24h) or on a closed day are left
  // untouched — the latter is then rejected with a clear "closed" message.
  private async mapAllDayToOperatingHours(
    tenantId: string, resource: Resource, start: Date, end: Date,
  ): Promise<{ start: Date; end: Date }> {
    const oh = resource.operatingHours;
    if (!oh) return { start, end };

    const cust = await this.customization.get(tenantId);
    const tz = (cust as { timezone?: string }).timezone;
    const s = utcToZonedWallClock(start, tz);
    const e = utcToZonedWallClock(end, tz);

    // Whole-day = starts at local midnight and runs to the end of that day
    // (23:59 same day, or rolled to 00:00 the next day).
    const startsAtMidnight = s.minutes === 0;
    const endsAtDayEnd =
      (e.dateStr !== s.dateStr && e.minutes === 0) ||
      (e.dateStr === s.dateStr && e.minutes >= 23 * 60 + 59);
    if (!startsAtMidnight || !endsAtDayEnd) return { start, end };

    const win = windowForWeekday(oh, s.weekday);
    if (!win) return { start, end }; // closed that day — let the hours check reject it clearly

    return {
      start: zonedTimeToUtc(s.dateStr, win.open, tz),
      end: zonedTimeToUtc(s.dateStr, win.close, tz),
    };
  }

  // Access control for restricted resources. An open resource (isRestricted
  // false) is bookable by anyone in the tenant. A restricted resource is
  // bookable by: (a) any admin role, or (b) — when the resource is scoped to a
  // department — a member of that department. A restricted resource with NO
  // department is admin-only. This is the gate `isRestricted` always implied
  // but never had; previously the flag was stored and ignored, so restricted
  // rooms were bookable by everyone.
  private async assertCanBook(tenantId: string, userId: string, resource: Resource) {
    if (!resource.isRestricted) return;

    const user = await this.users.findOne({
      where: { id: userId, tenantId },
      relations: { departments: true },
    });
    if (!user) throw new ForbiddenException('this resource is restricted');

    if (AdminRoles.includes(user.role as Role)) return;

    if (resource.departmentId) {
      const member = (user.departments || []).some((d) => d.id === resource.departmentId);
      if (member) return;
      throw new ForbiddenException('this resource is restricted to its department');
    }
    // Restricted but unscoped → admins only (handled above).
    throw new ForbiddenException('this resource is restricted');
  }

  // Validate + normalise answers to a resource's custom booking-form fields.
  // Required fields must have a non-empty value; unknown keys are dropped so a
  // client can't smuggle arbitrary data into the jsonb column. Returns the
  // cleaned map (only keys the resource actually defines).
  private validateCustomFields(
    resource: Resource, incoming?: Record<string, unknown>,
  ): Record<string, unknown> {
    const defs = resource.customFields || [];
    if (!defs.length) return {};
    const values = incoming || {};
    const cleaned: Record<string, unknown> = {};
    for (const def of defs) {
      const raw = values[def.key];
      const isEmpty = raw === undefined || raw === null || raw === '' ||
        (Array.isArray(raw) && raw.length === 0);
      if (def.required && isEmpty) {
        throw new BadRequestException(`"${def.label || def.key}" is required`);
      }
      if (!isEmpty) cleaned[def.key] = raw;
    }
    return cleaned;
  }

  // Resolve + validate the chargeback cost-center code for a booking. The
  // tenant's allowed codes live in customization.cost_centers. When that list
  // is non-empty a code is REQUIRED and must be one of the configured values
  // (the booking's explicit choice wins, else the resource's default). When
  // the tenant has configured no codes the field is optional and passes
  // through untouched — so existing tenants' booking flow is unaffected.
  private async resolveCostCenter(
    tenantId: string, requested: string | undefined, resource: Resource,
  ): Promise<string | null> {
    const code = (requested ?? resource.costCenterCode ?? '').trim();
    const cust = (await this.customization.get(tenantId)) as Record<string, any>;
    const allowed: string[] = Array.isArray(cust.cost_centers)
      ? cust.cost_centers.filter((x: unknown): x is string => typeof x === 'string' && !!x.trim())
      : [];
    if (!allowed.length) return code || null;
    if (!code) throw new BadRequestException('a cost center must be selected for this booking');
    if (!allowed.includes(code)) throw new BadRequestException(`unknown cost center "${code}"`);
    return code;
  }

  private async relatedResourceIds(m: EntityManager, tenantId: string, r: Resource): Promise<string[]> {
    const ids = new Set<string>([r.id]);
    if (r.compositeMode === 'child' && r.parentResourceId) ids.add(r.parentResourceId);
    if (r.compositeMode === 'parent') {
      const kids = await m.getRepository(Resource).find({ where: { tenantId, parentResourceId: r.id } });
      kids.forEach((k) => ids.add(k.id));
    }
    return [...ids];
  }
}

// --- Wall-clock series shifting (DST-safe) -------------------------------
// A series edit is expressed as a local-clock move: a new time-of-day plus a
// whole-day offset, both derived from how the anchor occurrence moved. Applying
// it re-encodes each occurrence through the tenant timezone, so the local clock
// stays put across DST transitions instead of drifting by the changed offset.
interface WallShift { dayOffset: number; hhmm: string }

// Parse a YYYY-MM-DD calendar date to a UTC midnight epoch — used only for
// DST-independent whole-day arithmetic on the date component.
function dateStrToUtcMs(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function addDaysToDateStr(s: string, n: number): string {
  const d = new Date(dateStrToUtcMs(s) + n * 86_400_000);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// Derive the wall-clock shift from the anchor's old → new instant in `tz`.
function wallShift(oldUtc: Date, newUtc: Date, tz?: string): WallShift {
  const o = utcToZonedWallClock(oldUtc, tz);
  const n = utcToZonedWallClock(newUtc, tz);
  return { dayOffset: Math.round((dateStrToUtcMs(n.dateStr) - dateStrToUtcMs(o.dateStr)) / 86_400_000), hhmm: n.hhmm };
}

// Apply a wall-clock shift to one occurrence: keep its own local date (plus the
// whole-day offset), set the new local time-of-day, re-encode to a UTC instant.
function applyWallShift(occUtc: Date, shift: WallShift, tz?: string): string {
  const w = utcToZonedWallClock(occUtc, tz);
  const newDate = addDaysToDateStr(w.dateStr, shift.dayOffset);
  return zonedTimeToUtc(newDate, shift.hhmm, tz).toISOString();
}
