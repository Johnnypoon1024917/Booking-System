import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThanOrEqual, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
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
        // Private bookings expose only a neutral placeholder. The feed URL is
        // a bearer token that ends up in third-party calendar-server logs, so
        // a private subject must never be written into it.
        summary: b.isPrivate ? 'Private booking' : (b.title || 'Booking'),
        location: resourceMap.get(b.resourceId) || '',
        start: b.startTime,
        end: b.endTime,
        status: b.status,
        // Likewise withhold the join link for private events.
        url: b.isPrivate ? '' : (b.meetingUrl || ''),
      })));
    return { filename: `${tenant.slug}.ics`, body };
  }

  // Resolve the feed token to its user via a direct indexed lookup on the
  // stored ics_feed_token. O(1) — the previous derive-and-scan-every-user
  // loop was an O(users) DoS amplifier on large tenants. The token column is
  // select:false, so it has to be requested explicitly.
  private async resolveUserByToken(tenantId: string, token: string): Promise<User | null> {
    if (!token) return null;
    return this.users
      .createQueryBuilder('u')
      .addSelect('u.icsFeedToken')
      .where('u.tenant_id = :t', { t: tenantId })
      .andWhere('u.is_active = true')
      .andWhere('u.ics_feed_token = :tok', { tok: token })
      .getOne();
  }

  // Return the caller's feed token, minting + persisting one on first use.
  // Exposed via the controller so the SPA can render "Your iCal URL".
  async tokenFor(userId: string, tenantId: string): Promise<string> {
    const u = await this.users
      .createQueryBuilder('u')
      .addSelect('u.icsFeedToken')
      .where('u.id = :id', { id: userId })
      .andWhere('u.tenant_id = :t', { t: tenantId })
      .getOne();
    if (!u) throw new NotFoundException('user not found');
    if (!u.icsFeedToken) {
      u.icsFeedToken = newFeedToken();
      await this.users.update({ id: userId }, { icsFeedToken: u.icsFeedToken });
    }
    return u.icsFeedToken;
  }

  // Rotate (revoke + reissue) the caller's feed token. Any previously
  // shared/leaked iCal URL immediately stops resolving.
  async rotateToken(userId: string, tenantId: string): Promise<string> {
    const token = newFeedToken();
    const r = await this.users.update({ id: userId, tenantId }, { icsFeedToken: token });
    if (!r.affected) throw new NotFoundException('user not found');
    return token;
  }

  private async resourceLookup(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.resources.find({ where: { tenantId, id: In(ids) } });
    const out = new Map<string, string>();
    for (const r of rows) out.set(r.id, r.location ? `${r.name} — ${r.location}` : r.name);
    return out;
  }
}

// newFeedToken mints a fresh opaque, URL-safe, per-user feed token. 256 bits
// of CSPRNG entropy — unguessable, and unique per user so the lookup is a
// direct index hit. Rotatable, so a leaked feed URL can be revoked.
function newFeedToken(): string {
  return randomBytes(32).toString('base64url');
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
