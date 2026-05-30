import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
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
import { BookingValidatorService } from './booking-validator.service';
import { utcToZonedWallClock, hhmmToMinutes } from '../../common/tz';
import { windowForWeekday, weekdayName } from '../../common/operating-hours';

// Terminal booking states are settled — their time window can no longer be
// rescheduled, and they can't be cancelled again. Guards reschedule/cancel
// against a Cancelled / No Show / Checked In booking.
const TERMINAL_STATUSES: ReadonlyArray<string> = ['Cancelled', 'No Show', 'Checked In'];

export interface CreateBookingDto {
  resourceId: string;
  startTime: string | Date;
  endTime: string | Date;
  title?: string;
  meetingUrl?: string;
  isPrivate?: boolean;
  customFieldValues?: Record<string, unknown>;
  // Chargeback / cost-center code to bill this booking against. Validated
  // against the tenant's configured list (customization.cost_centers).
  costCenterCode?: string;
}
export interface UpdateBookingDto {
  startTime?: string | Date;
  endTime?: string | Date;
  meetingUrl?: string;
  title?: string;
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
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (!(end > start)) throw new ConflictException('end must be after start');

    const resource = await this.resources.findOne({ where: { id: dto.resourceId, tenantId } });
    if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');

    await this.assertCanBook(tenantId, userId, resource);
    // Tenant-policy rules (past-date, horizon, duration, blackout, holiday),
    // with the resource's per-resource overrides layered on top (a room may
    // cap duration tighter — or loosen the horizon — vs the tenant default).
    // Authoritative server-side mirror of the SPA's useBookingRules.
    await this.validator.validate(tenantId, start, end, new Date(), resource.ruleOverrides ?? undefined);
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
        costCenterCode,
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
    return saved;
  }

  async update(tenantId: string, userId: string, role: string, id: string, dto: UpdateBookingDto) {
    const timeChanged = !!(dto.startTime || dto.endTime);

    // Authz, conflict re-check and save all run in one transaction. When the
    // time changes we lock the resource so the re-check + save can't race a
    // concurrent booking — the same TOCTOU fix as create().
    const saved = await this.bookings.manager.transaction(async (m) => {
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

      if (timeChanged) {
        const start = dto.startTime ? new Date(dto.startTime) : b.startTime;
        const end = dto.endTime ? new Date(dto.endTime) : b.endTime;
        if (!(end > start)) throw new ConflictException('end must be after start');
        const resource = await m.getRepository(Resource).findOne({ where: { id: b.resourceId, tenantId } });
        // Parity with create(): a missing or inactive resource is not
        // bookable. Previously `if (resource)` let a reschedule onto a
        // deleted/deactivated resource through with NO conflict check at all.
        if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');
        await this.validator.validate(tenantId, start, end, new Date(), resource.ruleOverrides ?? undefined);
        await this.assertWithinOperatingHours(tenantId, resource, start, end);
        const ids = await this.relatedResourceIds(m, tenantId, resource);
        await this.lockResources(m, tenantId, ids);
        await this.assertNoConflict(m, tenantId, ids, start, end, id, resource);
        // If the resource requires approval (per its override, else its own
        // flag), a reschedule re-enters the approval queue rather than
        // silently staying Confirmed.
        if ((resource.ruleOverrides?.requiresApproval ?? resource.requiresApproval) && b.status === 'Confirmed') {
          b.status = 'Pending Approval';
        }
        b.startTime = start;
        b.endTime = end;
      }
      if (dto.title !== undefined) b.title = dto.title;
      if (dto.meetingUrl !== undefined) b.meetingUrl = dto.meetingUrl;
      b.version += 1;
      return m.getRepository(Booking).save(b);
    });

    this.realtime.emit({
      type: 'booking.rescheduled',
      tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId: saved.userId,
    });
    this.dispatchSync('BOOKING_UPDATED', tenantId, saved.id);
    void this.notifications.enqueue(tenantId, 'BOOKING_UPDATED', saved);
    return saved;
  }

  async cancel(tenantId: string, userId: string, role: string, id: string, reason: string) {
    const b = await this.get(tenantId, id);
    if (b.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();
    // Idempotent: cancelling an already-cancelled booking is a no-op rather
    // than re-emitting events / notifications. A checked-in or no-show
    // booking is settled and can't be cancelled.
    if (b.status === 'Cancelled') return b;
    if (b.status === 'No Show' || b.status === 'Checked In') {
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

    // end-of-day bookings land exactly on close (e.g. 18:00) — allow that by
    // treating a local-midnight end (00:00, weekday rolled over) as the close.
    const endMinutes = (e.weekday !== s.weekday && e.minutes === 0) ? close : e.minutes;

    if (s.minutes < open || endMinutes > close) {
      throw new ConflictException(
        `outside ${weekdayName(s.weekday)} operating hours (${win.open}–${win.close})`,
      );
    }
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
