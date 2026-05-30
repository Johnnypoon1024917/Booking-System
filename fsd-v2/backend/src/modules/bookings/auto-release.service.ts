import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Booking } from './booking.entity';

// Auto-release flips Confirmed bookings that the user never checked
// into → No Show after a grace period. Freed slots become bookable on
// the very next conflict check.
//
// IMPORTANT: per the v1 user-preference memory ("auto-release off by
// default"), this is gated behind AUTO_RELEASE_ENABLED. The tick still
// runs on its cron schedule so we have logs proving it's wired up, but
// it short-circuits unless the env var is truthy. Operators flip it on
// per-tenant once their floor staff are ready for the behaviour change.
@Injectable()
export class AutoReleaseService {
  private readonly log = new Logger(AutoReleaseService.name);

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  private enabled(): boolean {
    const v = (process.env.AUTO_RELEASE_ENABLED || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  private graceMs(): number {
    const m = parseInt(process.env.AUTO_RELEASE_GRACE_MINUTES || '15', 10);
    return Math.max(1, isNaN(m) ? 15 : m) * 60 * 1000;
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'booking-auto-release' })
  async tick() {
    if (!this.enabled()) return { released: 0, skipped: 'disabled' };
    const cutoff = new Date(Date.now() - this.graceMs());
    const candidates = await this.bookings.find({
      where: {
        status: 'Confirmed',
        startTime: LessThan(cutoff),
      },
      take: 500,
    });
    let released = 0;
    for (const b of candidates) {
      if (b.checkedInAt) continue;
      b.status = 'No Show';
      b.exceptionNotes = b.exceptionNotes || 'auto-released: no check-in within grace period';
      try {
        await this.bookings.save(b);
        released++;
      } catch (e) {
        this.log.warn(`auto-release save failed for ${b.id}: ${(e as Error).message}`);
      }
    }
    if (released > 0) this.log.log(`auto-release tick: flipped ${released} bookings to No Show`);
    return { released, at: new Date() };
  }
}
