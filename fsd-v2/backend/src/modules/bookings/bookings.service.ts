import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Booking } from './booking.entity';
import { Resource } from '../resources/resource.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { OutlookSyncService } from '../outlook-sync/outlook-sync.service';
import { GoogleSyncService } from '../google-sync/google-sync.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface CreateBookingDto {
  resourceId: string;
  startTime: string | Date;
  endTime: string | Date;
  title?: string;
  meetingUrl?: string;
  isPrivate?: boolean;
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
    private readonly realtime: RealtimeGateway,
    private readonly outlookSync: OutlookSyncService,
    private readonly googleSync: GoogleSyncService,
    private readonly notifications: NotificationsService,
  ) {}

  // fire-and-forget calendar sync. Calendar push failures must never
  // block the primary booking write — the source of truth is our DB.
  private dispatchSync(eventName: string, tenantId: string, bookingId: string) {
    void (async () => {
      try {
        await this.outlookSync.handleBookingEvent(eventName, tenantId, bookingId);
      } catch (e) {
        this.log.warn(`outlook sync ${eventName} ${bookingId}: ${(e as Error).message}`);
      }
      try {
        await this.googleSync.handleBookingEvent(eventName, tenantId, bookingId);
      } catch (e) {
        this.log.warn(`google sync ${eventName} ${bookingId}: ${(e as Error).message}`);
      }
    })();
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

  async create(tenantId: string, userId: string, dto: CreateBookingDto) {
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);
    if (!(end > start)) throw new ConflictException('end must be after start');

    const resource = await this.resources.findOne({ where: { id: dto.resourceId, tenantId } });
    if (!resource || !resource.isActive) throw new NotFoundException('resource not bookable');

    await this.assertNoConflict(tenantId, resource, start, end, null);

    const b = this.bookings.create({
      tenantId, resourceId: resource.id, userId,
      startTime: start, endTime: end,
      title: dto.title || '',
      meetingUrl: dto.meetingUrl || '',
      isPrivate: !!dto.isPrivate,
      status: resource.requiresApproval ? 'Pending Approval' : 'Confirmed',
    });
    const saved = await this.bookings.save(b);
    this.realtime.emit({
      type: 'booking.created',
      tenantId, bookingId: saved.id, resourceId: saved.resourceId, userId,
    });
    this.dispatchSync('BOOKING_CREATED', tenantId, saved.id);
    // Pending-approval bookings still notify the owner that the request was
    // received; the event name drives which template the outbox renders.
    void this.notifications.enqueue(tenantId, 'BOOKING_CREATED', saved);
    return saved;
  }

  async update(tenantId: string, userId: string, role: string, id: string, dto: UpdateBookingDto) {
    const b = await this.get(tenantId, id);
    // Owner OR admin can edit. Mirrors v1's update_booking.go check.
    if (b.userId !== userId && !this.isAdmin(role)) throw new ForbiddenException();

    if (dto.startTime || dto.endTime) {
      const start = dto.startTime ? new Date(dto.startTime) : b.startTime;
      const end = dto.endTime ? new Date(dto.endTime) : b.endTime;
      if (!(end > start)) throw new ConflictException('end must be after start');
      const resource = await this.resources.findOne({ where: { id: b.resourceId, tenantId } });
      if (resource) await this.assertNoConflict(tenantId, resource, start, end, id);
      b.startTime = start;
      b.endTime = end;
    }
    if (dto.title !== undefined) b.title = dto.title;
    if (dto.meetingUrl !== undefined) b.meetingUrl = dto.meetingUrl;
    b.version += 1;
    const saved = await this.bookings.save(b);
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

  // Conflict detection. For a standalone room we check that room only;
  // for parent/child (split spaces) we also block siblings. Uses
  // tstzrange overlap (&&) the same way v1's EXCLUDE constraint does.
  private async assertNoConflict(
    tenantId: string, resource: Resource, start: Date, end: Date, excludeBookingId: string | null,
  ) {
    const ids = await this.relatedResourceIds(tenantId, resource);
    const qb = this.bookings.createQueryBuilder('b')
      .where('b.tenant_id = :t', { t: tenantId })
      .andWhere('b.resource_id IN (:...ids)', { ids })
      .andWhere(`b.status NOT IN ('Cancelled','No Show')`)
      .andWhere(
        `tstzrange(b.start_time, b.end_time, '[)') && tstzrange(:s, :e, '[)')`,
        { s: start, e: end },
      );
    if (excludeBookingId) qb.andWhere('b.id != :ex', { ex: excludeBookingId });
    const clash = await qb.getOne();
    if (clash) throw new ConflictException('time conflict — slot already booked');
  }

  private async relatedResourceIds(tenantId: string, r: Resource): Promise<string[]> {
    const ids = new Set<string>([r.id]);
    if (r.compositeMode === 'child' && r.parentResourceId) ids.add(r.parentResourceId);
    if (r.compositeMode === 'parent') {
      const kids = await this.resources.find({ where: { tenantId, parentResourceId: r.id } });
      kids.forEach((k) => ids.add(k.id));
    }
    return [...ids];
  }
}
