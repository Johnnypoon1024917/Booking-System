import { Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { Broadcast } from './broadcast.entity';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface BroadcastInput {
  title: string;
  content: string;
  severity?: string;
  color?: string;
  imageUrl?: string;
  startsAt?: string | Date;
  endsAt?: string | Date;
  filters?: Record<string, any>;
}

// Node's setTimeout stores its delay in a signed 32-bit int, so anything
// past ~24.8 days fires immediately. We cap each timer at HORIZON and, for
// broadcasts scheduled further out, re-arm at the horizon — bounded timers,
// no global sweep, and arbitrarily distant schedules still fire on time.
const HORIZON_MS = 24 * 3600 * 1000;

@Injectable()
export class BroadcastsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BroadcastsService.name);
  // broadcast id -> pending timers (start announce + end expiry). Keyed so a
  // re-save or delete can cancel and re-arm without leaking timers.
  private readonly timers = new Map<string, NodeJS.Timeout[]>();

  constructor(
    @InjectRepository(Broadcast) private readonly repo: Repository<Broadcast>,
    private readonly realtime: RealtimeGateway,
  ) {}

  // On boot, re-arm timers for every broadcast that is still live or yet to
  // start. The realtime bus is in-memory, so a process restart would otherwise
  // lose the precise "appear at 09:00:00" trigger and fall back to 60s polling.
  async onModuleInit() {
    const now = new Date();
    const pending = await this.repo.find({ where: { endsAt: MoreThanOrEqual(now) } });
    for (const b of pending) this.scheduleAnnouncement(b);
    if (pending.length) this.log.log(`armed realtime triggers for ${pending.length} broadcast(s)`);
  }

  onModuleDestroy() {
    for (const ts of this.timers.values()) ts.forEach(clearTimeout);
    this.timers.clear();
  }

  // Active = the window [startsAt, endsAt] currently contains "now".
  async findActive(tenantId: string, now: Date = new Date()) {
    return this.repo.find({
      where: {
        tenantId,
        startsAt: LessThanOrEqual(now),
        endsAt: MoreThanOrEqual(now),
      },
      order: { startsAt: 'DESC' },
    });
  }

  listAll(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { startsAt: 'DESC' } });
  }

  async create(tenantId: string, userId: string, input: BroadcastInput) {
    const b = this.repo.create({
      tenantId,
      createdBy: userId,
      ...this.normalise(input),
    });
    const saved = await this.repo.save(b);
    this.scheduleAnnouncement(saved);
    return saved;
  }

  async update(tenantId: string, id: string, input: BroadcastInput) {
    const existing = await this.repo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('broadcast not found');
    Object.assign(existing, this.normalise(input));
    const saved = await this.repo.save(existing);
    // Re-arm against the new window (start/severity/colour may have changed)
    // and push now so already-connected clients pick up the edit immediately.
    this.scheduleAnnouncement(saved);
    return saved;
  }

  async remove(tenantId: string, id: string) {
    const res = await this.repo.delete({ id, tenantId });
    if (!res.affected) throw new NotFoundException('broadcast not found');
    this.cancelTimers(id);
    // Nudge connected clients to re-fetch so a deleted live banner clears
    // without waiting out the 60s poll.
    this.realtime.emit({ type: 'broadcast.published', tenantId, payload: { broadcastId: id, removed: true } });
  }

  // --- Realtime triggers -----------------------------------------------
  // Push a `broadcast.published` event the instant a broadcast becomes live
  // (and again when it expires) so the banner appears/disappears on the dot
  // instead of up to 60s late in the client's polling cycle.
  private scheduleAnnouncement(b: Broadcast) {
    this.cancelTimers(b.id);
    const now = Date.now();
    const startsAt = new Date(b.startsAt).getTime();
    const endsAt = new Date(b.endsAt).getTime();
    if (endsAt <= now) return; // already over — nothing to announce

    const timers: NodeJS.Timeout[] = [];
    if (startsAt <= now) {
      // Live right now: announce immediately to every connected client.
      this.announce(b);
    } else {
      timers.push(this.armAt(startsAt - now, () => this.announce(b)));
    }
    // Expiry nudge so the banner clears promptly when the window closes.
    timers.push(this.armAt(endsAt - now, () => this.announce(b)));
    this.timers.set(b.id, timers);
  }

  // Schedule `fn` to run after `delay` ms, capping each timer at HORIZON_MS
  // and re-arming past the cap so distant schedules still fire on time.
  private armAt(delay: number, fn: () => void): NodeJS.Timeout {
    if (delay <= HORIZON_MS) return setTimeout(fn, Math.max(0, delay));
    return setTimeout(() => this.armAt(delay - HORIZON_MS, fn), HORIZON_MS);
  }

  private announce(b: Broadcast) {
    this.realtime.emit({
      type: 'broadcast.published',
      tenantId: b.tenantId,
      payload: { broadcastId: b.id, severity: b.severity, color: b.color || undefined },
    });
  }

  private cancelTimers(id: string) {
    const ts = this.timers.get(id);
    if (ts) { ts.forEach(clearTimeout); this.timers.delete(id); }
  }

  private normalise(input: BroadcastInput): Partial<Broadcast> {
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const endsAt = input.endsAt
      ? new Date(input.endsAt)
      : new Date(startsAt.getTime() + 24 * 3600 * 1000);
    const filters = { ...(input.filters || {}) };
    const severity = (input.severity || filters.severity || 'info').toLowerCase();
    filters.severity = severity;
    if (input.color) filters.color = input.color;
    return {
      title: input.title.trim(),
      content: input.content.trim(),
      severity,
      color: input.color ?? '',
      imageUrl: input.imageUrl ?? '',
      startsAt,
      endsAt,
      filters,
    };
  }
}
