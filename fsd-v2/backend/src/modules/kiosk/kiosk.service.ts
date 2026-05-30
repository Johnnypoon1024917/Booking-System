import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Resource } from '../resources/resource.entity';
import { Booking } from '../bookings/booking.entity';

@Injectable()
export class KioskService {
  constructor(
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  // Shared-secret check. KIOSK_TOKEN env is set per deployment; in prod
  // each kiosk device gets its own header value via reverse proxy.
  assertToken(token?: string) {
    const expected = process.env.KIOSK_TOKEN || '';
    if (!expected) return;            // unset disables the gate (dev mode)
    if (token !== expected) throw new UnauthorizedException('bad kiosk token');
  }

  // Current/next projection for the kiosk display. PII-stripped on
  // purpose — the display sits in a public corridor; no organiser
  // name, no meeting subject leaks out.
  async state(resourceId: string) {
    const r = await this.resources.findOne({ where: { id: resourceId } });
    if (!r) throw new NotFoundException('resource not found');
    const now = new Date();
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    const todays = await this.bookings.find({
      where: { resourceId },
      order: { startTime: 'ASC' },
    }).then((all) => all.filter((b) =>
      ['Confirmed', 'Checked In'].includes(b.status) &&
      b.startTime <= endOfDay && b.endTime >= now,
    ));
    const current = todays.find((b) => b.startTime <= now && b.endTime > now) ?? null;
    const next = todays.find((b) => b.startTime > now) ?? null;
    const project = (b: Booking | null) => b && ({
      start: b.startTime, end: b.endTime,
      summary: `${r.name} — Booked`,
    });
    return {
      resource: { id: r.id, name: r.name, location: r.location, capacity: r.capacity },
      now,
      current: project(current),
      next: project(next),
      // Strip PII before returning.
      agenda: todays.map((b) => ({
        start: b.startTime, end: b.endTime, summary: `${r.name} — Booked`,
      })),
    };
  }

  // Quick-book: from the kiosk, anyone present can grab a 30-min slot
  // starting now. No user identity — the booking is attributed to the
  // resource's tenant fallback user (handled by setting userId from env
  // KIOSK_BOOKING_USER_ID). Conflicts are rejected.
  async quickBook(resourceId: string, durationMinutes = 30, title = 'Walk-in') {
    const r = await this.resources.findOne({ where: { id: resourceId } });
    if (!r) throw new NotFoundException('resource not found');
    const userId = process.env.KIOSK_BOOKING_USER_ID;
    if (!userId) throw new BadRequestException('quick-book not configured (KIOSK_BOOKING_USER_ID)');

    const start = new Date();
    const end = new Date(start.getTime() + durationMinutes * 60_000);

    // Reject if anything overlaps the chosen window.
    const conflicts = await this.bookings.createQueryBuilder('b')
      .where('b.resource_id = :rid', { rid: resourceId })
      .andWhere(`b.status NOT IN ('Cancelled','No Show')`)
      .andWhere(
        `tstzrange(b.start_time, b.end_time, '[)') && tstzrange(:s, :e, '[)')`,
        { s: start, e: end },
      )
      .getCount();
    if (conflicts > 0) throw new BadRequestException('time slot occupied');

    return this.bookings.save(this.bookings.create({
      tenantId: r.tenantId, resourceId, userId,
      startTime: start, endTime: end,
      status: 'Confirmed', title,
    }));
  }
}
