import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from '../users/user.entity';
import { Booking } from '../bookings/booking.entity';
import { AuditEntry } from '../audit/audit.entity';

// DSAR bundle assembly. Mirrors v1 dsar_handler.go semantics — the
// goal is GDPR Art. 20 data portability, so the payload is structured
// JSON keyed by entity. Audit log entries are filtered to the caller
// as actor (and target if the FK ever lands).
@Injectable()
export class DsarService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(AuditEntry) private readonly audits: Repository<AuditEntry>,
  ) {}

  // Right-to-erasure (GDPR Art. 17 / HK PDPO). Implemented as anonymisation,
  // not a hard row delete: bookings and audit rows carry the user's FK and
  // are needed for the room ledger / security trail, so we strip the personal
  // data from the user row and from their bookings, deactivate the account,
  // and cancel any still-upcoming reservations so the rooms are freed. The
  // account can no longer authenticate (password/MFA/SSO/feed token all wiped).
  async eraseSelf(tenantId: string, userId: string): Promise<{ bookingsRedacted: number; upcomingCancelled: number }> {
    const anon = `erased-${userId.slice(0, 8)}`;

    // Redact PII on the user row + sever every credential path.
    await this.users.update({ id: userId, tenantId }, {
      username: anon,
      email: null as unknown as undefined,
      dn: null as unknown as undefined,
      grade: null as unknown as undefined,
      ssoProvider: null as unknown as undefined,
      ssoSubject: null as unknown as undefined,
      mfaSecret: null as unknown as undefined,
      mfaEnabled: false,
      passwordHash: '!erased!',
      icsFeedToken: null as unknown as undefined,
      regionAccess: [],
      isActive: false,
    });

    // Strip personal content (title / meeting link) from all of the user's
    // bookings — these free-text fields routinely contain personal data.
    const redact = await this.bookings.createQueryBuilder()
      .update(Booking)
      .set({ title: '', meetingUrl: '', redirectUrl: '' })
      .where('tenant_id = :t AND user_id = :u', { t: tenantId, u: userId })
      .execute();

    // Cancel still-upcoming reservations so the rooms aren't held by a
    // now-erased account.
    const cancel = await this.bookings.createQueryBuilder()
      .update(Booking)
      .set({ status: 'Cancelled', exceptionNotes: 'account erased' })
      .where('tenant_id = :t AND user_id = :u', { t: tenantId, u: userId })
      .andWhere('end_time > NOW()')
      .andWhere(`status NOT IN ('Cancelled','No Show')`)
      .execute();

    return { bookingsRedacted: redact.affected ?? 0, upcomingCancelled: cancel.affected ?? 0 };
  }

  async bundle(tenantId: string, userId: string) {
    // Profile — single row by composite PK (tenant_id+id) to keep
    // tenant isolation even if a UUID is guessed.
    const profile = await this.users.createQueryBuilder('u')
      .leftJoinAndSelect('u.departments', 'd')
      .where('u.id = :uid AND u.tenant_id = :tid', { uid: userId, tid: tenantId })
      .getOne();

    // Bookings — every booking the caller created.
    const bookings = await this.bookings.find({
      where: { tenantId, userId },
      order: { startTime: 'DESC' },
      take: 5000,
    });

    // Audit entries — caller as actor. Limited to 5000 to keep the
    // download bounded; v1 uses the same ceiling.
    const auditActor = await this.audits.find({
      where: { tenantId, userId },
      order: { createdAt: 'DESC' },
      take: 5000,
    });

    return {
      generatedAt: new Date().toISOString(),
      profile: profile && {
        id: profile.id,
        tenantId: profile.tenantId,
        username: profile.username,
        role: profile.role,
        grade: profile.grade,
        dn: profile.dn,
        isActive: profile.isActive,
        regionAccess: profile.regionAccess,
        departments: profile.departments?.map((d) => ({ id: d.id, name: d.name })),
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      bookings: bookings.map((b) => ({
        id: b.id,
        resourceId: b.resourceId,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        title: b.title,
        meetingUrl: b.meetingUrl,
        isPrivate: b.isPrivate,
        createdAt: b.createdAt,
      })),
      auditActor: auditActor.map((a) => ({
        id: a.id,
        action: a.action,
        severity: a.severity,
        outcome: a.outcome,
        targetEntity: a.targetEntity,
        targetId: a.targetId,
        previous: a.previous,
        next: a.next,
        createdAt: a.createdAt,
      })),
    };
  }
}
