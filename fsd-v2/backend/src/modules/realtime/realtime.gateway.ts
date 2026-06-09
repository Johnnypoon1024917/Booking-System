import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Subject, filter, map, Observable } from 'rxjs';
import { RedisService } from '../../common/redis/redis.service';

// Cross-cutting event bus. Every module can publish to it and the SSE endpoint
// subscribes to it. Per-tenant fan-out is the filter step on the subscribe side
// — we don't keep per-tenant subjects so a new tenant doesn't need a re-wire.
//
// HA / multi-instance: the local RxJS Subject only reaches SSE clients connected
// to THIS process. Behind a load balancer with N web servers, an event must
// reach clients on every node. So when Redis is enabled, emit() PUBLISHES to a
// shared channel instead of touching the local bus directly, and a per-process
// subscriber feeds every received event into the local bus. The originating
// node receives its own publish back through the subscription, so the single
// code path that drives the local bus is the Redis message handler — no double
// delivery. When Redis is disabled the original single-process behaviour
// applies (emit -> local bus directly).
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
  type: RealtimeEventType;
  tenantId: string;
  payload?: Record<string, any>;
  resourceId?: string;
  bookingId?: string;
  userId?: string;
  at: string; // ISO timestamp
}

const CHANNEL = 'realtime:events';

@Injectable()
export class RealtimeGateway implements OnModuleInit {
  private readonly log = new Logger(RealtimeGateway.name);
  private readonly bus = new Subject<RealtimeEvent>();

  constructor(private readonly redis: RedisService) {}

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
  emit(ev: Omit<RealtimeEvent, 'at'>) {
    const full: RealtimeEvent = { ...ev, at: new Date().toISOString() };
    if (this.redis.enabled) {
      // Fan out to every node; the subscription handler (ours included) is the
      // sole path that pushes onto the local bus, so this node's own clients
      // still get it — exactly once.
      void this.redis.publish(CHANNEL, JSON.stringify(full));
      return;
    }
    // Single-process fallback: straight onto the local bus.
    this.bus.next(full);
  }

  // Tenant-scoped stream. The SSE controller hands the caller's tenantId in from
  // the JWT so cross-tenant events are filtered out before they reach the wire.
  streamFor(tenantId: string): Observable<{ data: RealtimeEvent }> {
    return this.bus.asObservable().pipe(
      filter((ev) => ev.tenantId === tenantId),
      map((ev) => ({ data: ev })),
    );
  }
}
