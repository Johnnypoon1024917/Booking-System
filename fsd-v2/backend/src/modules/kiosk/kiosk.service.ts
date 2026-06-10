import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { Resource } from '../resources/resource.entity';
import { Booking } from '../bookings/booking.entity';
import { allowInsecureLocal } from '../../common/env';

// Per-tenant kiosk tokens, parsed once from KIOSK_TOKENS:
//   KIOSK_TOKENS="<tenantId>:<token>,<tenantId>:<token>"
// A device's token is validated against the token configured for the TENANT
// that owns the resource it's acting on — so a token issued for tenant A can
// never read or book tenant B's resources. KIOSK_TOKEN (single value) remains a
// back-compat fallback for single-tenant deployments.
let perTenantTokens: Map<string, string> | null = null;
function tenantTokens(): Map<string, string> {
  if (perTenantTokens) return perTenantTokens;
  const map = new Map<string, string>();
  for (const pair of (process.env.KIOSK_TOKENS || '').split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx <= 0) continue;
    map.set(trimmed.slice(0, idx).trim(), trimmed.slice(idx + 1).trim());
  }
  perTenantTokens = map;
  return map;
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

@Injectable()
export class KioskService {
  constructor(
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  // Validate the device token against the token configured for THIS resource's
  // tenant. Prefer a per-tenant token (KIOSK_TOKENS); fall back to the global
  // KIOSK_TOKEN for single-tenant deployments. Constant-time comparison.
  private assertToken(token: string | undefined, tenantId: string) {
    const expected = tenantTokens().get(tenantId) || process.env.KIOSK_TOKEN || '';
    if (!expected) {
      // Fail CLOSED (AUD-005): an unset token previously disabled the gate
      // entirely. Tolerate a missing token ONLY in explicit local development.
      if (allowInsecureLocal()) return;
      throw new UnauthorizedException('kiosk access is not configured for this tenant');
    }
    if (!token || !timingSafeEqualStr(token, expected)) {
      throw new UnauthorizedException('bad kiosk token');
    }
  }

  // Current/next projection for the kiosk display. PII-stripped on
  // purpose — the display sits in a public corridor; no organiser
  // name, no meeting subject leaks out.
  async state(resourceId: string, token?: string) {
    const r = await this.resources.findOne({ where: { id: resourceId } });
    if (!r) throw new NotFoundException('resource not found');
    this.assertToken(token, r.tenantId);
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
  async quickBook(resourceId: string, durationMinutes = 30, title = 'Walk-in', token?: string) {
    const r = await this.resources.findOne({ where: { id: resourceId } });
    if (!r) throw new NotFoundException('resource not found');
    this.assertToken(token, r.tenantId);
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
      // Walk-ins can't pick a chargeback code at the tablet, so inherit the
      // resource's default (if any) to keep cost-center reporting consistent.
      costCenterCode: r.costCenterCode ?? null,
    }));
  }
}
