import { Injectable } from '@nestjs/common';
import { Subject, filter, map, Observable } from 'rxjs';

// Single in-memory bus that every module can publish to and the SSE
// endpoint subscribes to. Per-tenant fan-out is the filter step on
// the subscribe side — we don't keep per-tenant subjects so a new
// tenant doesn't need a re-wire. Replace with Redis pub/sub when the
// platform scales past a single Nest process.
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

@Injectable()
export class RealtimeGateway {
  private readonly bus = new Subject<RealtimeEvent>();

  // Modules call this on state changes — services like BookingsService
  // and BroadcastsService inject the gateway and emit() after their
  // write succeeds.
  emit(ev: Omit<RealtimeEvent, 'at'>) {
    this.bus.next({ ...ev, at: new Date().toISOString() });
  }

  // Tenant-scoped stream. The SSE controller hands the caller's
  // tenantId in from the JWT so cross-tenant events are filtered out
  // before they ever reach the wire.
  streamFor(tenantId: string): Observable<{ data: RealtimeEvent }> {
    return this.bus.asObservable().pipe(
      filter((ev) => ev.tenantId === tenantId),
      map((ev) => ({ data: ev })),
    );
  }
}
