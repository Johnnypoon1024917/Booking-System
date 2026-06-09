import {
  Body, Controller, Get, Header, HttpCode, Logger, Post, Query, Req, Res, UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import * as crypto from 'crypto';
import { Public } from '../../common/decorators/public.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { GraphService } from './graph.service';

// GraphNotificationsController — receives Microsoft Graph change-
// notifications for subscribed room mailboxes.
//
// Two flows:
//
//   1. Validation handshake — Graph POSTs with ?validationToken=xxx during
//      subscription creation. We MUST echo it verbatim with content-type
//      text/plain within 10s.
//   2. Notification batch — Graph POSTs JSON {value:[{subscriptionId,
//      clientState, resourceData{id}, changeType, ...}]}. We verify the
//      persisted clientState constant-time, then ack 202 and reconcile
//      in the background.
//
// Endpoints:
//   POST /api/v1/integrations/graph/notifications  (public — validated by clientState)
//   POST /api/v1/integrations/graph/sync           (authenticated manual reconcile)
@ApiTags('integrations / graph')
@Controller('integrations/graph')
export class GraphController {
  private readonly log = new Logger(GraphController.name);

  constructor(private readonly graph: GraphService) {}

  @Public()
  @Post('notifications')
  @Header('Content-Type', 'text/plain')
  async notifications(
    @Query('validationToken') validationToken: string | undefined,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    // 1. Subscription-creation handshake
    if (validationToken) {
      res.status(200).send(validationToken);
      return;
    }
    // 2. Notification batch
    const values = Array.isArray(body?.value) ? body.value : [];
    for (const v of values) {
      const sub = await this.graph.findByGraphId(String(v.subscriptionId || ''));
      if (!sub) {
        this.log.warn(`graph notification: unknown subscription ${v.subscriptionId}`);
        continue;
      }
      const a = Buffer.from(String(v.clientState || ''));
      const b = Buffer.from(sub.clientState);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        this.log.warn(`graph notification: clientState mismatch for ${v.subscriptionId}`);
        continue;
      }
      // Reconcile is intentionally a no-op stub today — the v1 inbound
      // reconciler is large enough to warrant its own follow-up port.
      // The handshake + auth path is what Graph polls before it'll
      // deliver anything, so getting it right is the load-bearing part.
      this.log.log(`graph event ${v.changeType} on ${v.resource} (sub ${v.subscriptionId})`);
    }
    res.status(202).send('');
  }

  // Manual "reconcile now" — surfaced as an admin action in the UI for
  // operators who want to force a renewal pass instead of waiting an hour.
  // Admin-gated (AUD-018): triggers tenant-wide Graph subscription renewal,
  // so a plain authenticated user must not be able to invoke it.
  @Post('sync') @HttpCode(202)
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  async manualSync() {
    await this.graph.renewExpiring();
    return { status: 'reconcile-triggered' };
  }
}
