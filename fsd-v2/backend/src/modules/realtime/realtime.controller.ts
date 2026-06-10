import { Controller, MessageEvent, Req, Sse } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { RealtimeGateway } from './realtime.gateway';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { SkipTenantTx } from '../../common/decorators/skip-tenant-tx.decorator';

// SSE-based live event stream. v1 used a raw WebSocket; SSE is simpler
// here because Nest has a first-class @Sse decorator that auto-handles
// reconnection headers and never needs a separate upgrade dance.
// Clients consume via EventSource('/api/v1/realtime') — the standard
// browser API does automatic reconnect with exponential backoff.
@ApiTags('realtime')
@ApiBearerAuth()
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly gateway: RealtimeGateway) {}

  // A never-completing SSE stream must NOT run inside the per-request tenant
  // transaction — that would pin a pooled connection (and hold a transaction
  // open) for the entire lifetime of the connection. Tenant scoping here is
  // enforced in the gateway from the JWT tenantId.
  @SkipTenantTx()
  @Sse()
  @ApiOperation({
    summary: 'Server-sent events stream for tenant-scoped lifecycle events',
  })
  stream(@CurrentUser() user: AuthUser, @Req() req: Request): Observable<MessageEvent> {
    // A reconnecting EventSource resends the id of the last event it saw via the
    // standard Last-Event-ID header; the gateway replays anything newer from the
    // per-tenant buffer before resuming the live stream.
    const lastEventId = (req.headers['last-event-id'] as string | undefined) || undefined;
    return this.gateway.streamFor(user.tenantId, user.id, lastEventId);
  }
}
