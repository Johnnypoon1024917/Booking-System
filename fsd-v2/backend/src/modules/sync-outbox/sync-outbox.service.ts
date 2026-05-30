import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Repository } from 'typeorm';
import { SyncOutbox } from './sync-outbox.entity';
import { OutlookSyncService } from '../outlook-sync/outlook-sync.service';
import { GoogleSyncService } from '../google-sync/google-sync.service';

const MAX_ATTEMPTS = 6;
const DRAIN_BATCH = 50;
// A row left in 'processing' longer than this is assumed orphaned by a
// crashed/restarted worker and is reclaimed by the next drain.
const STALE_PROCESSING_MS = 10 * 60 * 1000;

// Drains the calendar-sync outbox: pushes each pending booking change to
// Outlook + Google with exponential backoff, so a transient Graph/Google
// outage no longer silently drops the event. Both per-provider adapters are
// idempotent (they upsert a per-booking sync record), so re-running a row on
// retry updates the existing remote event rather than duplicating it.
@Injectable()
export class SyncOutboxService {
  private readonly log = new Logger(SyncOutboxService.name);

  constructor(
    @InjectRepository(SyncOutbox) private readonly outbox: Repository<SyncOutbox>,
    private readonly outlookSync: OutlookSyncService,
    private readonly googleSync: GoogleSyncService,
  ) {}

  // enqueue writes one durable pending row. Called from the booking write path
  // after commit; never throws into the caller (a queue write failure must not
  // roll back the booking — worst case the sync is simply not scheduled, same
  // as the old fire-and-forget behaviour).
  async enqueue(event: string, tenantId: string, bookingId: string): Promise<void> {
    try {
      await this.outbox.save(this.outbox.create({
        tenantId, bookingId, event,
        status: 'pending', attemptCount: 0, nextAttemptAt: new Date(),
      }));
    } catch (e) {
      this.log.warn(`sync enqueue ${event} ${bookingId} failed: ${(e as Error).message}`);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async drain(): Promise<void> {
    const claimed = await this.claimDue();
    for (const row of claimed) await this.deliverOne(row);
  }

  // claimDue atomically flips a batch of due rows from 'pending' to
  // 'processing' inside a single locked transaction. FOR UPDATE SKIP LOCKED
  // guarantees no concurrent/overrunning drain tick can claim the same rows,
  // so a slow Graph/Google push can't trigger parallel re-processing. Rows
  // orphaned in 'processing' by a crashed worker are reclaimed here too.
  private claimDue(): Promise<SyncOutbox[]> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    return this.outbox.manager.transaction(async (em) => {
      const rows = await em.createQueryBuilder(SyncOutbox, 'o')
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
        await em.update(SyncOutbox, rows.map((r) => r.id), { status: 'processing' });
      }
      return rows;
    });
  }

  private async deliverOne(row: SyncOutbox): Promise<void> {
    const errors: string[] = [];
    // Push to both providers independently; a per-provider failure shouldn't
    // stop the other. Idempotent adapters make a full re-run on retry safe.
    try {
      await this.outlookSync.handleBookingEvent(row.event, row.tenantId, row.bookingId);
    } catch (e) {
      errors.push(`outlook: ${(e as Error).message}`);
    }
    try {
      await this.googleSync.handleBookingEvent(row.event, row.tenantId, row.bookingId);
    } catch (e) {
      errors.push(`google: ${(e as Error).message}`);
    }

    if (errors.length === 0) {
      row.status = 'sent';
      row.sentAt = new Date();
      row.lastError = undefined;
    } else {
      row.attemptCount += 1;
      row.lastError = errors.join('; ').slice(0, 1024);
      if (row.attemptCount >= MAX_ATTEMPTS) {
        row.status = 'failed';
        this.log.warn(`calendar sync ${row.id} (${row.event} ${row.bookingId}) failed permanently: ${row.lastError}`);
      } else {
        // Hand the claimed row back to the pool for a future tick.
        row.status = 'pending';
        // 30s, 2m, 8m, 32m, … — matches the notification/webhook backoff curve.
        const delaySec = 30 * Math.pow(4, row.attemptCount - 1);
        row.nextAttemptAt = new Date(Date.now() + delaySec * 1000);
      }
    }
    await this.outbox.save(row);
  }
}
