import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as crypto from 'crypto';
import { Webhook, WebhookDelivery } from './webhook.entity';
import { validateWebhookTargetURL } from './webhook-url';

// WebhooksService — admin CRUD + outbox dispatcher.
//
// Domain events call `enqueue(tenantId, event, payload)` which finds
// every active subscription matching the event name and writes one
// WebhookDelivery row per match. The EVERY_MINUTE cron picks them up,
// HMAC-signs the body with the subscription's secret, posts to the
// target URL, and updates status. Failed attempts back off
// exponentially up to MAX_ATTEMPTS.
const DEFAULT_EVENTS = [
  'booking.created', 'booking.updated', 'booking.cancelled',
  'booking.approved', 'booking.rejected', 'weather.signal',
];
const MAX_ATTEMPTS = 6;
const DELIVERY_TIMEOUT_MS = 10_000;
const DRAIN_BATCH = 50;
// A delivery left in 'processing' longer than this is assumed orphaned by a
// crashed/restarted worker and is reclaimed by the next drain.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

@Injectable()
export class WebhooksService {
  private readonly log = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(Webhook) private readonly subs: Repository<Webhook>,
    @InjectRepository(WebhookDelivery) private readonly deliveries: Repository<WebhookDelivery>,
  ) {}

  // --- CRUD ---------------------------------------------------------------

  async list(tenantId: string) {
    const rows = await this.subs.find({ where: { tenantId }, order: { targetURL: 'ASC' } });
    // Never echo the secret back. The "rotate" action would issue a new
    // one through a dedicated endpoint (future work).
    return rows.map((r) => ({
      id: r.id, targetURL: r.targetURL, events: r.events,
      isActive: r.isActive, hasSecret: !!r.secret,
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    }));
  }

  async create(tenantId: string, input: { targetURL: string; events?: string[] }) {
    await validateWebhookTargetURL(input.targetURL);
    const events = input.events?.length ? input.events : DEFAULT_EVENTS;
    const secret = 'whsec_' + crypto.randomBytes(32).toString('hex');
    const row = await this.subs.save(this.subs.create({
      tenantId, targetURL: input.targetURL, events, secret, isActive: true,
    }));
    // Return the secret ONCE — admins must persist it now.
    return {
      id: row.id, targetURL: row.targetURL, events: row.events,
      isActive: row.isActive, secret,
      note: 'Store this secret now. It will not be shown again.',
    };
  }

  async update(
    tenantId: string, id: string,
    input: { targetURL?: string; events?: string[]; isActive?: boolean },
  ) {
    const row = await this.subs.findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('webhook not found');
    if (input.targetURL !== undefined && input.targetURL !== row.targetURL) {
      await validateWebhookTargetURL(input.targetURL);
      row.targetURL = input.targetURL;
    }
    if (input.events) row.events = input.events;
    if (input.isActive !== undefined) row.isActive = input.isActive;
    await this.subs.save(row);
  }

  async delete(tenantId: string, id: string) {
    const r = await this.subs.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('webhook not found');
  }

  listDeliveries(tenantId: string, limit = 100) {
    return this.deliveries.find({
      where: { tenantId }, order: { createdAt: 'DESC' },
      take: Math.min(limit, 500),
    });
  }

  // --- enqueue + dispatch -------------------------------------------------

  // enqueue is called from domain event hooks (e.g. BookingsService.create).
  // We do a fan-out write into webhook_deliveries — one row per matching
  // subscription — so the cron can dispatch each independently and one
  // slow target doesn't stall the rest.
  async enqueue(tenantId: string, event: string, payload: Record<string, any>): Promise<void> {
    const matches = await this.subs
      .createQueryBuilder('w')
      .where('w.tenant_id = :t', { t: tenantId })
      .andWhere('w.is_active = true')
      .andWhere(`w.events @> :ev::jsonb`, { ev: JSON.stringify([event]) })
      .getMany();

    if (matches.length === 0) return;
    const now = new Date();
    const rows = matches.map((m) => this.deliveries.create({
      tenantId, subscriptionId: m.id, event, payload,
      status: 'pending' as const, attemptCount: 0,
      nextAttemptAt: now,
    }));
    await this.deliveries.save(rows);
  }

  // EVERY_MINUTE outbox drain. Atomically claims a bounded batch of due rows
  // and attempts delivery serially per row to keep memory predictable.
  @Cron(CronExpression.EVERY_MINUTE)
  async drain(): Promise<void> {
    const claimed = await this.claimDue();
    for (const d of claimed) await this.deliverOne(d);
  }

  // claimDue atomically flips a batch of due deliveries from 'pending' to
  // 'processing' inside a single locked transaction. FOR UPDATE SKIP LOCKED
  // guarantees no other drain tick — or a second app instance — can claim the
  // same rows, so a drain that overruns the 1-minute cron interval (slow
  // target) can never re-POST the same webhook. Rows orphaned in 'processing'
  // by a crashed worker (older than STALE_PROCESSING_MS) are reclaimed here.
  private claimDue(): Promise<WebhookDelivery[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    return this.deliveries.manager.transaction(async (em) => {
      const rows = await em.createQueryBuilder(WebhookDelivery, 'd')
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .where('d.nextAttemptAt <= :now', { now })
        .andWhere(
          '(d.status = :pending OR (d.status = :processing AND d.updatedAt <= :staleBefore))',
          { pending: 'pending', processing: 'processing', staleBefore },
        )
        .orderBy('d.nextAttemptAt', 'ASC')
        .take(DRAIN_BATCH)
        .getMany();
      if (rows.length) {
        await em.update(WebhookDelivery, rows.map((r) => r.id), { status: 'processing' });
      }
      return rows;
    });
  }

  private async deliverOne(d: WebhookDelivery): Promise<void> {
    const sub = await this.subs.findOne({ where: { id: d.subscriptionId } });
    if (!sub || !sub.isActive) {
      d.status = 'failed';
      d.lastError = 'subscription missing or inactive';
      await this.deliveries.save(d);
      return;
    }
    // Re-validate the target at SEND time, not just at create/update. The
    // create-time check resolves DNS once; an attacker can register a public
    // hostname, pass validation, then re-point it at 169.254.169.254 / an
    // internal host before the cron fires (DNS rebinding). Resolving + checking
    // every A/AAAA again here shrinks that window to sub-second. (A fully
    // airtight fix pins the connect to the validated IP via a custom dispatcher
    // — a follow-up; this closes the practical rebinding vector.)
    try {
      await validateWebhookTargetURL(sub.targetURL);
    } catch (e: any) {
      d.attemptCount += 1;
      d.status = d.attemptCount >= MAX_ATTEMPTS ? 'failed' : 'pending';
      d.lastError = `target failed safety re-validation: ${String(e?.message || e).slice(0, 512)}`;
      if (d.status === 'pending') d.nextAttemptAt = new Date(Date.now() + 30 * 60_000);
      await this.deliveries.save(d);
      return;
    }
    const body = JSON.stringify({
      id: d.id, event: d.event, tenantId: d.tenantId,
      occurredAt: d.createdAt.toISOString(), data: d.payload,
    });
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto
      .createHmac('sha256', sub.secret)
      .update(ts + '.' + body)
      .digest('hex');

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT_MS);
    let status = 0, errMsg = '';
    try {
      const resp = await fetch(sub.targetURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-FSD-Event': d.event,
          'X-FSD-Delivery': d.id,
          'X-FSD-Timestamp': ts,
          'X-FSD-Signature': `t=${ts},v1=${sig}`,
        },
        body,
        signal: ctrl.signal,
      });
      status = resp.status;
      if (status >= 400) errMsg = (await resp.text()).slice(0, 1024);
    } catch (e: any) {
      errMsg = String(e?.message || e).slice(0, 1024);
    } finally {
      clearTimeout(timer);
    }

    d.attemptCount += 1;
    d.lastStatus = status || null;
    d.lastError = errMsg;
    if (status >= 200 && status < 300) {
      d.status = 'sent';
      d.deliveredAt = new Date();
    } else if (d.attemptCount >= MAX_ATTEMPTS) {
      d.status = 'failed';
    } else {
      // Quartic backoff: 30s, 2m, 8m, 32m, 128m, ... (30·4^(n-1)).
      // Hand the claimed row back to the pool for a future tick.
      d.status = 'pending';
      const delaySec = 30 * Math.pow(4, d.attemptCount - 1);
      d.nextAttemptAt = new Date(Date.now() + delaySec * 1000);
    }
    await this.deliveries.save(d);
  }
}
