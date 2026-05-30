import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { createHash } from 'crypto';
import { Booking } from './booking.entity';
import { Tenant } from '../tenants/tenant.entity';
import { User } from '../users/user.entity';
import { Resource } from '../resources/resource.entity';

// ProductID identifies the producer per RFC 5545 §3.7.3. Matches the
// v1 string so iCal clients merge subscriptions across the cut-over.
const PRODUCT_ID = '-//FSD MRBS Platform//Booking Engine 2.0//EN';

@Injectable()
export class IcsService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
  ) {}

  // Look up the tenant by slug, validate the per-user token, then
  // emit a VCALENDAR for the user's upcoming confirmed bookings.
  // Token check is constant-time on the hash so we don't leak length.
  async feedForTenant(tenantSlug: string, token: string): Promise<{ filename: string; body: string }> {
    const tenant = await this.tenants.findOne({ where: { slug: tenantSlug } });
    if (!tenant) throw new NotFoundException('tenant not found');
    if (!token) throw new UnauthorizedException('token required');

    const user = await this.resolveUserByToken(tenant.id, token);
    if (!user) throw new UnauthorizedException('invalid token');

    const since = new Date();
    const horizon = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    const rows = await this.bookings.find({
      where: {
        tenantId: tenant.id,
        userId: user.id,
        startTime: MoreThanOrEqual(since),
      },
      order: { startTime: 'ASC' },
      take: 500,
    });

    const resourceMap = await this.resourceLookup(tenant.id, rows.map((r) => r.resourceId));
    const body = encodeFeed(`${tenant.name} bookings`, rows
      .filter((b) => b.status !== 'Cancelled' && b.status !== 'No Show' && b.startTime < horizon)
      .map((b) => ({
        uid: `${b.id}@${tenant.slug}.fsd-mrbs`,
        sequence: b.version || 0,
        summary: b.title || 'Booking',
        location: resourceMap.get(b.resourceId) || '',
        start: b.startTime,
        end: b.endTime,
        status: b.status,
        url: b.meetingUrl || '',
      })));
    return { filename: `${tenant.slug}.ics`, body };
  }

  // Tokens are an opaque per-user secret. For now we derive them
  // deterministically from (tenant, user, JWT secret) — same trick v1
  // used so users can subscribe once and never need to rotate. When we
  // ship rotation, swap this for a stored hash column on `users`.
  private async resolveUserByToken(tenantId: string, token: string): Promise<User | null> {
    const candidates = await this.users.find({ where: { tenantId, isActive: true } });
    for (const u of candidates) {
      if (constantTimeEq(icsTokenFor(u.id, tenantId), token)) return u;
    }
    return null;
  }

  // Helper exposed via controller so the SPA can show "Your iCal URL".
  tokenFor(userId: string, tenantId: string): string {
    return icsTokenFor(userId, tenantId);
  }

  private async resourceLookup(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.resources.find({ where: { tenantId, id: In(ids) } });
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, r.location ? `${r.name} — ${r.location}` : r.name);
    return out;
  }
}

// icsTokenFor produces a stable, opaque, per-user feed token. Long
// enough to resist guessing but still URL-safe and human-pasteable.
export function icsTokenFor(userId: string, tenantId: string): string {
  const secret = process.env.ICS_FEED_SECRET || process.env.JWT_SECRET || 'fsd-ics-default';
  return createHash('sha256').update(`${userId}|${tenantId}|${secret}`).digest('base64url').slice(0, 32);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- ICS encoder (kept in this file to avoid sprawl) -------------

interface IcsEvent {
  uid: string;
  sequence: number;
  summary: string;
  location: string;
  start: Date;
  end: Date;
  status: string;
  url: string;
}

function encodeFeed(name: string, events: IcsEvent[]): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:' + PRODUCT_ID);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  if (name) {
    lines.push(kv('X-WR-CALNAME', name));
    lines.push(kv('X-WR-CALDESC', 'FSD MRBS bookings'));
  }
  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + ev.uid);
    lines.push('SEQUENCE:' + ev.sequence);
    lines.push('DTSTAMP:' + utc(new Date()));
    lines.push('DTSTART:' + utc(ev.start));
    lines.push('DTEND:' + utc(ev.end));
    lines.push(kv('SUMMARY', ev.summary));
    if (ev.location) lines.push(kv('LOCATION', ev.location));
    if (ev.url) lines.push(kv('URL', ev.url));
    lines.push('STATUS:CONFIRMED');
    lines.push('TRANSP:OPAQUE');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// encodeInvite emits a single-VEVENT VCALENDAR suitable for attaching to a
// notification email. METHOD:REQUEST tells the mail client to add/update the
// event in the recipient's calendar; METHOD:CANCEL (with STATUS:CANCELLED)
// withdraws it. Mirrors v1's ics.MethodRequest / ics.MethodCancel so invites
// round-trip across the cut-over. The ATTENDEE line lets Outlook/Gmail match
// the invite to the recipient's mailbox.
export function encodeInvite(opts: {
  uid: string;
  sequence: number;
  method: 'REQUEST' | 'CANCEL';
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  url?: string;
  organizerEmail?: string;
  attendeeEmail?: string;
  attendeeName?: string;
}): string {
  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:' + PRODUCT_ID);
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:' + opts.method);
  lines.push('BEGIN:VEVENT');
  lines.push('UID:' + opts.uid);
  lines.push('SEQUENCE:' + opts.sequence);
  lines.push('DTSTAMP:' + utc(new Date()));
  lines.push('DTSTART:' + utc(opts.start));
  lines.push('DTEND:' + utc(opts.end));
  lines.push(kv('SUMMARY', opts.summary));
  if (opts.description) lines.push(kv('DESCRIPTION', opts.description));
  if (opts.location) lines.push(kv('LOCATION', opts.location));
  if (opts.url) lines.push(kv('URL', opts.url));
  if (opts.organizerEmail) lines.push('ORGANIZER:mailto:' + opts.organizerEmail);
  if (opts.attendeeEmail) {
    const cn = opts.attendeeName ? `;CN=${escapeText(opts.attendeeName)}` : '';
    lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE${cn}:mailto:${opts.attendeeEmail}`);
  }
  lines.push('STATUS:' + (opts.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'));
  lines.push('TRANSP:OPAQUE');
  lines.push('END:VEVENT');
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function kv(key: string, val: string): string {
  return key + ':' + escapeText(val);
}

function escapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\n/g, '\\n').replace(/\r/g, '');
}

function utc(t: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`;
}

// RFC 5545 §3.1 line folding: split at 75 octets, continuations start
// with a single space.
function fold(line: string): string {
  const LIMIT = 75;
  if (line.length <= LIMIT) return line;
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += LIMIT) {
    chunks.push(line.slice(i, i + LIMIT));
  }
  return chunks.join('\r\n ');
}
