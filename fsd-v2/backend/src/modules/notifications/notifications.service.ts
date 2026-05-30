import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationOutbox } from './notification-outbox.entity';
import { NotificationTemplate, NotificationTemplateType } from './notification-template.entity';
import { SmtpService } from './smtp.service';
import { PushService } from '../push/push.service';
import { Booking } from '../bookings/booking.entity';
import { User } from '../users/user.entity';
import { Resource } from '../resources/resource.entity';
import { encodeInvite } from '../bookings/ics.service';
import {
  defaultTemplate, localizeStatus, normalizeLocale, pushMessage,
} from './notifications.i18n';

const MAX_ATTEMPTS = 6;
const DRAIN_BATCH = 50;
// A row left in 'processing' longer than this is assumed orphaned by a
// crashed/restarted worker and is reclaimed by the next drain.
const STALE_PROCESSING_MS = 10 * 60 * 1000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(NotificationOutbox) private readonly outbox: Repository<NotificationOutbox>,
    @InjectRepository(NotificationTemplate) private readonly templates: Repository<NotificationTemplate>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    private readonly smtp: SmtpService,
    private readonly push: PushService,
  ) {}

  // enqueue resolves the recipient + frozen template vars and writes one
  // pending outbox row. Called from the booking write path; it must never
  // throw into the caller (a notification failure must not roll back a
  // booking), so errors are logged and swallowed.
  async enqueue(tenantId: string, event: string, booking: Booking): Promise<void> {
    try {
      const user = await this.users.findOne({ where: { id: booking.userId, tenantId } });
      const email = resolveEmail(user);
      if (!email) {
        this.log.warn(`no email for user ${booking.userId}; skipping ${event} for booking ${booking.id}`);
        return;
      }
      const resource = await this.resources.findOne({ where: { id: booking.resourceId, tenantId } });
      const vars = {
        BookingID: booking.id,
        // Recipient identity + locale frozen at enqueue time: UserId drives the
        // push fan-out in deliverOne; Locale selects the default template and
        // the localised Status label so the email/push match the user's
        // preferred language even if they change it later.
        UserId: booking.userId,
        Locale: normalizeLocale(user?.locale),
        UserName: user?.username || '',
        ResourceName: resource ? (resource.location ? `${resource.name} — ${resource.location}` : resource.name) : '',
        Status: booking.status,
        StartTime: booking.startTime.toISOString(),
        EndTime: booking.endTime.toISOString(),
        MeetingUrl: booking.meetingUrl || '',
        Title: booking.title || '',
        Sequence: booking.version || 0,
      };
      await this.outbox.save(this.outbox.create({
        tenantId, bookingId: booking.id, event,
        recipientEmail: email, vars,
        status: 'pending', attemptCount: 0, nextAttemptAt: new Date(),
      }));
    } catch (e) {
      this.log.warn(`enqueue ${event} for booking ${booking.id} failed: ${(e as Error).message}`);
    }
  }

  // EVERY_MINUTE outbox drain — mirrors WebhooksService.drain. Atomically
  // claims a bounded batch of due rows, then sends each serially with
  // exponential backoff on failure.
  @Cron(CronExpression.EVERY_MINUTE)
  async drain(): Promise<void> {
    const claimed = await this.claimDue();
    for (const row of claimed) await this.deliverOne(row);
  }

  // claimDue atomically flips a batch of due rows from 'pending' to
  // 'processing' inside a single locked transaction. FOR UPDATE SKIP LOCKED
  // guarantees no other drain tick — or a second app instance — can claim the
  // same rows, so a drain that overruns the 1-minute cron interval (slow SMTP)
  // can never double-send. Rows orphaned in 'processing' by a crashed worker
  // (older than STALE_PROCESSING_MS) are reclaimed here too.
  private claimDue(): Promise<NotificationOutbox[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    return this.outbox.manager.transaction(async (em) => {
      const rows = await em.createQueryBuilder(NotificationOutbox, 'o')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('o.nextAttemptAt <= :now', { now })
        .andWhere(
          '(o.status = :pending OR (o.status = :processing AND o.updatedAt <= :staleBefore))',
          { pending: 'pending', processing: 'processing', staleBefore },
        )
        .orderBy('o.nextAttemptAt', 'ASC')
        .take(DRAIN_BATCH)
        .getMany();
      if (rows.length) {
        await em.update(NotificationOutbox, rows.map((r) => r.id), { status: 'processing' });
      }
      return rows;
    });
  }

  private async deliverOne(row: NotificationOutbox): Promise<void> {
    try {
      const { subject, html } = await this.render(row.tenantId, row.event, row.vars);
      const ics = this.buildIcs(row.tenantId, row.event, row.vars, row.recipientEmail);
      await this.smtp.send({ to: row.recipientEmail, subject, html, ics });
      row.status = 'sent';
      row.sentAt = new Date();
      row.lastError = undefined;
      // Email delivered — fan out the matching browser push exactly once (this
      // is the only attempt that succeeds, so no duplicate-push risk on retry).
      // Best-effort: PushService swallows per-subscription errors internally.
      await this.deliverPush(row);
    } catch (e) {
      row.attemptCount += 1;
      row.lastError = String((e as Error)?.message || e).slice(0, 1024);
      if (row.attemptCount >= MAX_ATTEMPTS) {
        row.status = 'failed';
        this.log.warn(`notification ${row.id} failed permanently: ${row.lastError}`);
      } else {
        // Hand the claimed row back to the pool for a future tick.
        row.status = 'pending';
        // 30s, 2m, 8m, 32m, ... matching the webhooks backoff curve.
        const delaySec = 30 * Math.pow(4, row.attemptCount - 1);
        row.nextAttemptAt = new Date(Date.now() + delaySec * 1000);
      }
    }
    await this.outbox.save(row);
  }

  // deliverPush mirrors the email as a browser push notification, localised to
  // the recipient's frozen locale. Never throws into deliverOne — a push
  // failure must not flip a successfully-emailed row back to retry.
  private async deliverPush(row: NotificationOutbox): Promise<void> {
    try {
      const userId = row.vars.UserId as string | undefined;
      if (!userId || !this.push.isConfigured()) return;
      const locale = normalizeLocale(row.vars.Locale);
      const type = templateTypeFor(row.event);
      const msg = pushMessage(locale, type);
      const display = { ...row.vars, Status: localizeStatus(String(row.vars.Status ?? ''), locale) };
      await this.push.sendToUser(row.tenantId, userId, {
        title: substitute(msg.subject, display),
        body: substitute(msg.body, display),
        url: row.vars.MeetingUrl || undefined,
      });
    } catch (e) {
      this.log.warn(`push for notification ${row.id} failed: ${(e as Error).message}`);
    }
  }

  // ---- template CRUD (admin) --------------------------------------------

  listTemplates(tenantId: string) {
    return this.templates.find({ where: { tenantId }, order: { templateType: 'ASC' } });
  }

  async upsertTemplate(
    tenantId: string, templateType: NotificationTemplateType, subject: string, bodyTemplate: string,
  ) {
    const existing = await this.templates.findOne({ where: { tenantId, templateType } });
    if (existing) {
      existing.subject = subject;
      existing.bodyTemplate = bodyTemplate;
      return this.templates.save(existing);
    }
    return this.templates.save(this.templates.create({ tenantId, templateType, subject, bodyTemplate }));
  }

  async deleteTemplate(tenantId: string, id: string): Promise<boolean> {
    const r = await this.templates.delete({ id, tenantId });
    return !!r.affected;
  }

  // ---- rendering --------------------------------------------------------

  // render resolves the per-tenant template for the event, falling back to the
  // built-in defaults localised to the recipient's preferred language. The
  // injected Status enum is mapped to a localised label first so it never
  // appears as a raw English database value (e.g. "Pending Approval").
  private async render(tenantId: string, event: string, vars: Record<string, any>) {
    const type = templateTypeFor(event);
    const locale = normalizeLocale(vars.Locale);
    // Display copy of the vars with the Status enum localised. Applied to both
    // tenant overrides and defaults so {{Status}} is always reader-friendly.
    const display = { ...vars, Status: localizeStatus(String(vars.Status ?? ''), locale) };
    const tpl = await this.templates.findOne({ where: { tenantId, templateType: type } });
    if (tpl) {
      return {
        subject: substitute(tpl.subject, display),
        html: substitute(tpl.bodyTemplate, display),
      };
    }
    const def = defaultTemplate(locale, type);
    return {
      subject: substitute(def.subject, display),
      html: substitute(def.body, display),
    };
  }

  private buildIcs(tenantId: string, event: string, vars: Record<string, any>, attendee: string) {
    const cancel = event === 'BOOKING_CANCELLED' || event === 'BOOKING_REJECTED'
      || event === 'BOOKING_AUTO_RELEASED';
    return {
      filename: `booking-${vars.BookingID}.ics`,
      method: (cancel ? 'CANCEL' : 'REQUEST') as 'CANCEL' | 'REQUEST',
      content: encodeInvite({
        // Tenant-scoped UID so the iCalendar domain is isolated per tenant
        // rather than sharing a single hardcoded @fsd-mrbs namespace.
        uid: `${vars.BookingID}@${tenantId}.fsd-mrbs.local`,
        sequence: Number(vars.Sequence) || 0,
        method: cancel ? 'CANCEL' : 'REQUEST',
        summary: vars.Title || vars.ResourceName || 'Booking',
        description: `Status: ${vars.Status}`,
        location: vars.ResourceName,
        start: new Date(vars.StartTime),
        end: new Date(vars.EndTime),
        url: vars.MeetingUrl,
        organizerEmail: process.env.SMTP_FROM || 'no-reply@fsd-mrbs.local',
        attendeeEmail: attendee,
        attendeeName: vars.UserName,
      }),
    };
  }
}

// resolveEmail prefers the stored email column, falling back to `username`
// when it parses as an email address (the chosen rollout strategy: add the
// column but degrade gracefully for users whose email hasn't synced yet).
function resolveEmail(user: User | null): string | null {
  if (!user) return null;
  if (user.email && EMAIL_RE.test(user.email)) return user.email;
  if (EMAIL_RE.test(user.username)) return user.username;
  return null;
}

// templateTypeFor maps a domain event to a template type. Mirrors v1's
// cmd/worker templateTypeFor.
function templateTypeFor(event: string): NotificationTemplateType {
  switch (event) {
    case 'BOOKING_CANCELLED':
    case 'BOOKING_REJECTED':
    case 'BOOKING_AUTO_RELEASED':
      return 'cancellation';
    default:
      return 'confirmation';
  }
}

// substitute supports both {{Field}} and {{.Field}} (the latter matching
// v1's Go-template syntax) so tenant templates copied from v1 keep working.
function substitute(tpl: string, vars: Record<string, any>): string {
  return tpl.replace(/\{\{\s*\.?(\w+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v === undefined || v === null ? '' : String(v);
  });
}
