import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationOutbox } from './notification-outbox.entity';
import { NotificationTemplate, NotificationTemplateType } from './notification-template.entity';
import { SmtpService } from './smtp.service';
import { Booking } from '../bookings/booking.entity';
import { User } from '../users/user.entity';
import { Resource } from '../resources/resource.entity';
import { encodeInvite } from '../bookings/ics.service';

const MAX_ATTEMPTS = 6;
const DRAIN_BATCH = 50;
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

  // EVERY_MINUTE outbox drain — mirrors WebhooksService.drain. Picks a
  // bounded batch of due rows and sends each serially with exponential
  // backoff on failure.
  @Cron(CronExpression.EVERY_MINUTE)
  async drain(): Promise<void> {
    const due = await this.outbox.find({
      where: { status: 'pending', nextAttemptAt: LessThanOrEqual(new Date()) },
      take: DRAIN_BATCH, order: { nextAttemptAt: 'ASC' },
    });
    for (const row of due) await this.deliverOne(row);
  }

  private async deliverOne(row: NotificationOutbox): Promise<void> {
    try {
      const { subject, html } = await this.render(row.tenantId, row.event, row.vars);
      const ics = this.buildIcs(row.event, row.vars, row.recipientEmail);
      await this.smtp.send({ to: row.recipientEmail, subject, html, ics });
      row.status = 'sent';
      row.sentAt = new Date();
      row.lastError = undefined;
    } catch (e) {
      row.attemptCount += 1;
      row.lastError = String((e as Error)?.message || e).slice(0, 1024);
      if (row.attemptCount >= MAX_ATTEMPTS) {
        row.status = 'failed';
        this.log.warn(`notification ${row.id} failed permanently: ${row.lastError}`);
      } else {
        // 30s, 2m, 8m, 32m, ... matching the webhooks backoff curve.
        const delaySec = 30 * Math.pow(4, row.attemptCount - 1);
        row.nextAttemptAt = new Date(Date.now() + delaySec * 1000);
      }
    }
    await this.outbox.save(row);
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

  // render resolves the per-tenant template for the event, falling back to
  // the built-in defaults (mirrors v1's renderTemplate fallback behaviour).
  private async render(tenantId: string, event: string, vars: Record<string, any>) {
    const type = templateTypeFor(event);
    const tpl = await this.templates.findOne({ where: { tenantId, templateType: type } });
    if (tpl) {
      return {
        subject: substitute(tpl.subject, vars),
        html: substitute(tpl.bodyTemplate, vars),
      };
    }
    const def = DEFAULT_TEMPLATES[type];
    return {
      subject: substitute(def.subject, vars),
      html: substitute(def.body, vars),
    };
  }

  private buildIcs(event: string, vars: Record<string, any>, attendee: string) {
    const cancel = event === 'BOOKING_CANCELLED' || event === 'BOOKING_REJECTED'
      || event === 'BOOKING_AUTO_RELEASED';
    return {
      filename: `booking-${vars.BookingID}.ics`,
      method: (cancel ? 'CANCEL' : 'REQUEST') as 'CANCEL' | 'REQUEST',
      content: encodeInvite({
        uid: `${vars.BookingID}@fsd-mrbs`,
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

const DEFAULT_TEMPLATES: Record<NotificationTemplateType, { subject: string; body: string }> = {
  confirmation: {
    subject: 'Booking {{Status}}: {{ResourceName}}',
    body: `<p>Hello {{UserName}},</p>
<p>Your booking for <strong>{{ResourceName}}</strong> is now <strong>{{Status}}</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>
<p>The attached calendar invite (.ics) will update your Outlook / Gmail automatically.</p>`,
  },
  cancellation: {
    subject: 'Booking cancelled: {{ResourceName}}',
    body: `<p>Hello {{UserName}},</p>
<p>Your booking for <strong>{{ResourceName}}</strong> has been <strong>cancelled</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>
<p>The attached calendar cancellation (.ics) will remove the event from your calendar automatically.</p>`,
  },
  reminder: {
    subject: 'Reminder: {{ResourceName}} at {{StartTime}}',
    body: `<p>Hello {{UserName}},</p>
<p>This is a reminder for your upcoming booking of <strong>{{ResourceName}}</strong>.</p>
<ul>
  <li>Start: {{StartTime}}</li>
  <li>End: {{EndTime}}</li>
</ul>`,
  },
};
