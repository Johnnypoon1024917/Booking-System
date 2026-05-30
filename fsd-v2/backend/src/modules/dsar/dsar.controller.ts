import { Controller, Get, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';

import { DsarService } from './dsar.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

// Self-service data subject access (GDPR Art. 15 / 20, HK PDPO DPP6).
// Authentication is required — JwtAuthGuard is global. The caller can
// only export their OWN bundle; admin-initiated DSAR on behalf of
// another user is a separate admin flow.
@ApiTags('dsar')
@ApiBearerAuth()
@Controller('dsar')
export class DsarController {
  constructor(
    private readonly svc: DsarService,
    private readonly audit: AuditService,
  ) {}

  @Get('me')
  @ApiOperation({ summary: 'Export the calling user\'s personal data as a JSON download' })
  async exportMe(@CurrentUser() u: AuthUser, @Res() res: Response) {
    const bundle = await this.svc.bundle(u.tenantId, u.id);

    // Audit at SeverityCritical — data export is a sensitive operation
    // even when self-service, because the resulting file leaves the
    // platform boundary.
    await this.audit.record(u, {
      action: 'DSAR_EXPORT',
      severity: 'critical',
      targetEntity: 'user',
      targetId: u.id,
      next: { kind: 'dsar', bookings: bundle.bookings.length, audit: bundle.auditActor.length },
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=my-data-${u.username}.json`);
    res.send(JSON.stringify(bundle, null, 2));
  }
}
