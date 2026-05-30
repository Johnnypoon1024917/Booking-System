import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { Booking } from './booking.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';

// Default time a check-in QR token is valid for once issued. 24h matches
// v1's CheckinUseCase ttl.
const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class CheckinService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    private readonly realtime: RealtimeGateway,
  ) {}

  // Public helper so the kiosk redeem flow can publish a checked_in
  // event with the booking-derived tenantId.
  private emitCheckedIn(b: Booking) {
    this.realtime.emit({
      type: 'booking.checked_in',
      tenantId: b.tenantId, bookingId: b.id,
      resourceId: b.resourceId, userId: b.userId,
    });
  }

  // Issue a fresh single-use token for the kiosk QR code. Persisting
  // the token directly on the booking row keeps the schema small —
  // v1 used a separate checkin_tokens table for revocation history,
  // but v2 can add that later without breaking the wire format.
  async issueToken(tenantId: string, bookingId: string): Promise<{ token: string; expiresAt: Date }> {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    const token = randomBytes(18).toString('base64url');
    const expiresAt = new Date(Date.now() + DEFAULT_TOKEN_TTL_MS);
    b.checkinToken = token;
    b.checkinTokenExpiresAt = expiresAt;
    await this.bookings.save(b);
    return { token, expiresAt };
  }

  // Owner / admin check-in. Flips Confirmed → Checked In.
  async checkinByBooking(tenantId: string, userId: string, isAdmin: boolean, bookingId: string) {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (b.userId !== userId && !isAdmin) throw new ForbiddenException();
    return this.applyCheckin(b);
  }

  // Public kiosk path: redeem a token without auth. The token itself is
  // the bearer credential; once consumed it can't be reused.
  async redeemToken(token: string) {
    if (!token) throw new BadRequestException('missing token');
    const b = await this.bookings.findOne({ where: { checkinToken: token } });
    if (!b) throw new NotFoundException('invalid token');
    if (b.checkinTokenExpiresAt && b.checkinTokenExpiresAt < new Date()) {
      throw new BadRequestException('token expired');
    }
    const saved = await this.applyCheckin(b);
    // Consume: blank the token so a second scan fails.
    saved.checkinToken = undefined;
    saved.checkinTokenExpiresAt = undefined;
    await this.bookings.save(saved);
    return { bookingId: saved.id, checkedInAt: saved.checkedInAt };
  }

  // Admin: explicit no-show flip. Same effect as auto-release but
  // available on demand for known-skipped meetings.
  async markNoShow(tenantId: string, bookingId: string, reason?: string) {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (b.status === 'Cancelled' || b.status === 'No Show') return b;
    b.status = 'No Show';
    b.exceptionNotes = reason?.trim() || b.exceptionNotes || 'admin marked no-show';
    const saved = await this.bookings.save(b);
    this.realtime.emit({
      type: 'booking.no_show',
      tenantId: saved.tenantId, bookingId: saved.id,
      resourceId: saved.resourceId, userId: saved.userId,
    });
    return saved;
  }

  // Admin: mark a booking as Attended — post-hoc confirmation that the
  // meeting actually took place. Reachable from any non-terminal state
  // (Confirmed / Checked In / Pending Approval); a Cancelled or No Show
  // booking can't retroactively become Attended. Idempotent.
  async markAttended(tenantId: string, bookingId: string) {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (b.status === 'Attended') return b;
    if (b.status === 'Cancelled' || b.status === 'No Show') {
      throw new BadRequestException(`cannot mark attended: booking is ${b.status}`);
    }
    b.status = 'Attended';
    const saved = await this.bookings.save(b);
    this.realtime.emit({
      type: 'booking.attended',
      tenantId: saved.tenantId, bookingId: saved.id,
      resourceId: saved.resourceId, userId: saved.userId,
    });
    return saved;
  }

  private async applyCheckin(b: Booking) {
    if (b.status === 'Cancelled' || b.status === 'No Show') {
      throw new BadRequestException(`cannot check in: booking is ${b.status}`);
    }
    if (b.status === 'Checked In') return b;
    b.status = 'Checked In';
    b.checkedInAt = new Date();
    const saved = await this.bookings.save(b);
    this.emitCheckedIn(saved);
    return saved;
  }
}
