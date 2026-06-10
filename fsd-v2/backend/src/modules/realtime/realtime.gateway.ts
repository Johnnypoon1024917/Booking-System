import {
  HttpException, HttpStatus, Injectable, Logger, MessageEvent, OnApplicationShutdown, OnModuleInit,
} from '@nestjs/common';
import { Subject, filter, map, Observable, concat, from, defer, mergeMap, merge, interval, finalize } from 'rxjs';
import { RedisService } from '../../common/redis/redis.service';
import { MetricsService } from '../../common/observability/metrics.service';

// Cross-cutting event bus. Every module can publish to it and the SSE endpoint
// subscribes to it. Per-tenant fan-out is the filter step on the subscribe side
// — we don't keep per-tenant subjects so a new tenant doesn't need a re-wire.
//
// HA / multi-instance: the local RxJS Subject only reaches SSE clients connected
// to THIS process. Behind a load balancer with N web servers, an event must
// reach clients on every node. So when Redis is enabled, emit() PUBLISHES to a
// shared channel instead of touching the local bus directly, and a per-process
// subscriber feeds every received event into the local bus. When Redis is
// disabled the original single-process behaviour applies (emit -> local bus).
//
// Missed-event replay: pub/sub is fire-and-forget — an event fired while a
// client is disconnected is gone. So each event also gets a monotonic `id` (a
// global Redis counter) and is appended to a per-tenant, capped, TTL'd buffer.
// A reconnecting EventSource sends the standard `Last-Event-ID` header; the SSE
// endpoint replays everything in the buffer with a higher id BEFORE switching to
// the live stream, so the client catches up exactly on what it missed. (The
// frontend also refetches on reconnect as a belt-and-suspenders for the tiny
// window between the replay snapshot and the live subscription, and dedupes by
// id.)
export type RealtimeEventType =
  | 'booking.created'
  | 'booking.cancelled'
  | 'booking.rescheduled'
  | 'booking.checked_in'
  | 'booking.attended'
  | 'booking.no_show'
  | 'broadcast.published'
  | 'weather.signal';

export interface RealtimeEvent {
  id: string; // monotonic sequence, used as the SSE event id for Last-Event-ID replay
  type: RealtimeEventType;
  tenantId: string;
  payload?: Record<string, any>;
  resourceId?: string;
  bookingId?: string;
  userId?: string;
  at: string; // ISO timestamp
}

const CHANNEL = 'realtime:events';
const SEQ_KEY = 'realtime:seq';
const bufferKey = (tenantId: string) => `realtime:buf:${tenantId}`;
const BUFFER_MAX = 200; // keep the last N events per tenant for replay
const BUFFER_TTL_SEC = 3600; // ...covering up to ~1h of client disconnection
// Per-user concurrent SSE connection cap — a never-completing stream is cheap to
// open, so without a cap a single user/script can exhaust the event loop's
// handles. A handful of tabs/devices is legitimate.
const MAX_SSE_PER_USER = parseInt(process.env.SSE_MAX_PER_USER || '5', 10);
// Keepalive frame so proxies/load balancers don't reap an idle stream and so a
// half-open TCP connection is detected. Sent as a NAMED event so the browser's
// default onmessage handler ignores it (no client-side noise).
const HEARTBEAT_MS = 25_000;

@Injectable()
export class RealtimeGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly bus = new Subject<RealtimeEvent>();
  // Live SSE connection count per user, for the per-user cap.
  private readonly conns = new Map<string, number>();
  // Fallback id source when Redis is disabled (single-node dev). Cross-node
  // ordering needs the shared Redis counter; one process can use a local one.
  private localSeq = 0;

  constructor(
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    // Every node — including the publisher — receives events on the shared
    // channel and feeds them to its own SSE clients. No-op when Redis is off.
    this.redis.subscribe(CHANNEL, (raw) => {
      try {
        this.bus.next(JSON.parse(raw) as RealtimeEvent);
      } catch (e) {
        this.log.warn(`dropping malformed realtime message: ${(e as Error).message}`);
      }
    });
  }

  // Modules call this on state changes — services like BookingsService and
  // BroadcastsService inject the gateway and emit() after their write succeeds.
  // Fire-and-forget: id assignment + buffering + publish happen asynchronously
  // so callers aren't blocked on Redis.
  emit(ev: Omit<RealtimeEvent, 'at' | 'id'>) {
    void this.publishEvent(ev);
  }

  private async publishEvent(ev: Omit<RealtimeEvent, 'at' | 'id'>) {
    const full: RealtimeEvent = { ...ev, id: await this.nextId(), at: new Date().toISOString() };
    if (this.redis.enabled && this.redis.cmd) {
      const payload = JSON.stringify(full);
      // Append to the per-tenant replay buffer (best-effort; a buffer failure
      // must not stop live delivery). LTRIM caps it; EXPIRE bounds idle tenants.
      try {
        const key = bufferKey(full.tenantId);
        await this.redis.cmd
          .multi()
          .lpush(key, payload)
          .ltrim(key, 0, BUFFER_MAX - 1)
          .expire(key, BUFFER_TTL_SEC)
          .exec();
      } catch (e) {
        this.log.warn(`realtime buffer write failed: ${(e as Error).message}`);
      }
      // Fan out live to every node; the subscription handler (ours included) is
      // the sole path that pushes onto the local bus, so this node's own clients
      // still get it — exactly once. If the publish FAILS (Redis down), fall
      // back to the local bus so at least this node's clients keep receiving —
      // otherwise a Redis outage would silently kill realtime everywhere.
      const published = await this.redis.publish(CHANNEL, payload);
      if (!published) this.bus.next(full);
      return;
    }
    // Single-process fallback: straight onto the local bus.
    this.bus.next(full);
  }

  private async nextId(): Promise<string> {
    if (this.redis.enabled && this.redis.cmd) {
      try {
        return String(await this.redis.cmd.incr(SEQ_KEY));
      } catch {
        // fall through to the local counter on a Redis hiccup
      }
    }
    return String(++this.localSeq);
  }

  // Tenant-scoped stream. The SSE controller hands the caller's tenantId + userId
  // in from the JWT so cross-tenant events are filtered out before they reach the
  // wire and the per-user connection cap can be enforced. When lastEventId is
  // supplied (a reconnecting EventSource), replay the missed tail first.
  streamFor(tenantId: string, userId: string, lastEventId?: string): Observable<MessageEvent> {
    const live$ = this.bus.asObservable().pipe(
      filter((ev) => ev.tenantId === tenantId),
      map((ev) => this.toMessage(ev)),
    );

    const events$ =
      this.redis.enabled && lastEventId
        ? // concat: drain replay (in id order) fully, THEN switch to live.
          concat(
            defer(() => from(this.replay(tenantId, lastEventId))).pipe(
              mergeMap((events) => from(events)),
              map((ev) => this.toMessage(ev)),
            ),
            live$,
          )
        : live$;

    // Keepalive merged in as a named event (ignored by the browser's onmessage).
    const heartbeat$: Observable<MessageEvent> = interval(HEARTBEAT_MS).pipe(
      map(() => ({ data: 'ping', type: 'heartbeat' })),
    );

    // Enforce the per-user cap at subscribe time and release on disconnect.
    return defer(() => {
      if (!this.acquire(userId)) {
        throw new HttpException('too many concurrent realtime streams', HttpStatus.TOO_MANY_REQUESTS);
      }
      return merge(events$, heartbeat$).pipe(finalize(() => this.release(userId)));
    });
  }

  private acquire(userId: string): boolean {
    const n = this.conns.get(userId) ?? 0;
    if (n >= MAX_SSE_PER_USER) return false;
    this.conns.set(userId, n + 1);
    this.metrics.sseInc();
    return true;
  }

  private release(userId: string) {
    const n = (this.conns.get(userId) ?? 1) - 1;
    if (n <= 0) this.conns.delete(userId);
    else this.conns.set(userId, n);
    this.metrics.sseDec();
  }

  // Graceful shutdown: complete the bus so every open SSE stream ends cleanly
  // (clients reconnect via EventSource) instead of being severed mid-frame.
  onApplicationShutdown() {
    this.bus.complete();
  }

  private toMessage(ev: RealtimeEvent): MessageEvent {
    // Setting `id` makes Nest emit `id:` on the wire, so EventSource records it
    // and sends it back as Last-Event-ID on the next reconnect.
    return { data: ev, id: ev.id };
  }

  private async replay(tenantId: string, lastEventId: string): Promise<RealtimeEvent[]> {
    if (!this.redis.cmd) return [];
    const since = Number(lastEventId);
    if (!Number.isFinite(since)) return [];
    try {
      const raw = await this.redis.cmd.lrange(bufferKey(tenantId), 0, -1);
      const missed = raw
        .map((r) => JSON.parse(r) as RealtimeEvent)
        .filter((e) => Number(e.id) > since)
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (missed.length) {
        this.log.log(`replaying ${missed.length} missed event(s) to a reconnecting client (tenant ${tenantId}, after id ${since})`);
      }
      return missed;
    } catch (e) {
      this.log.warn(`realtime replay failed: ${(e as Error).message}`);
      return [];
    }
  }
}
