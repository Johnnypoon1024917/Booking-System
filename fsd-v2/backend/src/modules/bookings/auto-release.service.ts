import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThan, Repository } from 'typeorm';
import { Booking } from './booking.entity';
import { Resource } from '../resources/resource.entity';
import { CustomizationService } from '../customization/customization.service';
import { NotificationsService } from '../notifications/notifications.service';

// Auto-release ("ghost booking" sweep) flips Confirmed bookings the user
// never checked into → No Show once a grace period after the start has
// elapsed, freeing the slot for the next conflict check, and emails the
// owner so they know their reservation was released.
//
// Per-tenant, not global: whether it runs and the grace period are resolved
// per booking from the tenant's customization (auto_release.enabled /
// .grace_minutes), and the grace can be tightened further per resource via
// resource.ruleOverrides.graceMinutes. A tenant that has never opted in
// falls back to the legacy AUTO_RELEASE_ENABLED / AUTO_RELEASE_GRACE_MINUTES
// env switches, so existing deployments behave exactly as before.
@Injectable()
export class AutoReleaseService {
  private readonly log = new Logger(AutoReleaseService.name);

  // Coarse pre-filter floor. We can't query per-tenant grace in SQL, so the
  // sweep fetches every Confirmed, un-checked-in booking whose start is at
  // least this many minutes in the past, then re-checks the resolved grace
  // per row before flipping. Set below the smallest grace anyone would
  // realistically configure so no eligible booking is missed.
  private static readonly MIN_GRACE_MINUTES = 1;

  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Resource) private readonly resources: Repository<Resource>,
    private readonly customization: CustomizationService,
    private readonly notifications: NotificationsService,
  ) {}

  // Legacy global fallback, used only when a tenant has not set
  // auto_release.enabled in its customization.
  private envEnabled(): boolean {
    const v = (process.env.AUTO_RELEASE_ENABLED || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  private envGraceMinutes(): number {
    const m = parseInt(process.env.AUTO_RELEASE_GRACE_MINUTES || '15', 10);
    return Math.max(1, isNaN(m) ? 15 : m);
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: 'booking-auto-release' })
  async tick() {
    const now = Date.now();
    const coarseCutoff = new Date(now - AutoReleaseService.MIN_GRACE_MINUTES * 60_000);

    // Candidate set: Confirmed, never checked in, started before the coarse
    // cutoff. Bounded so one tick can never run away on a huge backlog.
    const candidates = await this.bookings.find({
      where: {
        status: 'Confirmed',
        checkedInAt: IsNull(),
        startTime: LessThan(coarseCutoff),
      },
      order: { startTime: 'ASC' },
      take: 1000,
    });
    if (!candidates.length) return { released: 0, at: new Date(now) };

    // Cache per-tenant customization and per-resource rows for the tick so a
    // backlog spanning many bookings of the same tenant/room doesn't issue an
    // N+1 storm of lookups.
    const custCache = new Map<string, Record<string, any>>();
    const resCache = new Map<string, Resource | null>();
    let released = 0;

    for (const b of candidates) {
      let cust = custCache.get(b.tenantId);
      if (!cust) {
        cust = (await this.customization.get(b.tenantId)) as Record<string, any>;
        custCache.set(b.tenantId, cust);
      }
      const cfg = (cust.auto_release || {}) as { enabled?: boolean; grace_minutes?: number };
      const enabled = cfg.enabled ?? this.envEnabled();
      if (!enabled) continue;

      let resource = resCache.get(b.resourceId);
      if (resource === undefined) {
        resource = await this.resources.findOne({ where: { id: b.resourceId, tenantId: b.tenantId } });
        resCache.set(b.resourceId, resource);
      }

      // Resolve grace: per-resource override → tenant default → env fallback.
      const graceMinutes = positiveInt(resource?.ruleOverrides?.graceMinutes)
        ?? positiveInt(cfg.grace_minutes)
        ?? this.envGraceMinutes();
      const releaseAt = b.startTime.getTime() + graceMinutes * 60_000;
      if (now < releaseAt) continue; // still within this booking's grace window

      // Flip to No Show with an ATOMIC, conditional UPDATE — never save(b).
      // The candidate row was read at the top of the tick; by the time we get
      // here a kiosk scan may have already checked the user in. A blind save(b)
      // would clobber that Checked-In write with our stale No-Show snapshot
      // ("lost update"), permanently mis-flagging a user who DID show up. The
      // WHERE re-asserts the preconditions (still Confirmed, still not checked
      // in) so the DB only flips rows the scan hasn't claimed — and the loser
      // of the race no-ops (affected === 0) instead of overwriting.
      const notes = b.exceptionNotes || 'auto-released: no check-in within grace period';
      try {
        const res = await this.bookings.update(
          { id: b.id, status: 'Confirmed', checkedInAt: IsNull() },
          { status: 'No Show', exceptionNotes: notes },
        );
        if (res.affected) {
          released++;
          // Warn the owner their reservation was released (fire-and-forget; a
          // mail failure must never abort the sweep). Reflect the persisted
          // state on the in-memory row the notification renders from.
          b.status = 'No Show';
          b.exceptionNotes = notes;
          void this.notifications.enqueue(b.tenantId, 'BOOKING_AUTO_RELEASED', b);
        }
      } catch (e) {
        this.log.warn(`auto-release update failed for ${b.id}: ${(e as Error).message}`);
      }
    }

    if (released > 0) this.log.log(`auto-release tick: flipped ${released} bookings to No Show`);
    return { released, at: new Date(now) };
  }
}

// Returns a positive integer, or undefined for null/absent/non-positive —
// so an unset override (or a 0) transparently falls through to the next
// grace source rather than releasing every booking immediately.
function positiveInt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}
