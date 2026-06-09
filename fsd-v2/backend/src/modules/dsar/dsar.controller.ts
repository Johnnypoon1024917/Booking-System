import { Body, Controller, Delete, Get, HttpCode, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';

import { DsarService } from './dsar.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';

class ErasureRequestDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class EraseMeDto {
  // Current password — required to re-authenticate before irreversible erasure.
  @IsString() currentPassword!: string;
}

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

  // Right-to-erasure (GDPR Art. 17 / HK PDPO). v2 has no automated self-service
  // erasure pipeline — deletion is irreversible and frequently constrained by
  // retention obligations — so a request is recorded as a critical audit event
  // for an administrator to action within the statutory window, rather than the
  // button being a dead no-op. The audit row is the durable, queryable record
  // admins triage from.
  @Post('erasure-request')
  @HttpCode(202)
  @ApiOperation({ summary: 'Request erasure of the calling user\'s account (queued for administrator action)' })
  async requestErasure(@CurrentUser() u: AuthUser, @Body() body: ErasureRequestDto) {
    await this.audit.record(u, {
      action: 'DSAR_ERASURE_REQUESTED',
      severity: 'critical',
      targetEntity: 'user',
      targetId: u.id,
      next: { kind: 'erasure_request', reason: body?.reason || '' },
    });
    return { status: 'received', message: 'Erasure request logged for administrator action.' };
  }

  // Immediate self-service erasure (GDPR Art. 17). Anonymises the account and
  // the caller's bookings and deactivates the login. Audited at critical
  // BEFORE the redaction loses the identity context. The client must discard
  // its session afterwards — the account can no longer authenticate.
  @Delete('me')
  @ApiOperation({ summary: 'Erase (anonymise + deactivate) the calling user\'s own account' })
  async eraseMe(@CurrentUser() u: AuthUser, @Body() body: EraseMeDto) {
    // Verify the password BEFORE writing the audit row / redacting, so a failed
    // re-auth doesn't leave a misleading DSAR_ERASED trail.
    const result = await this.svc.eraseSelf(u.tenantId, u.id, body.currentPassword);
    await this.audit.record(u, {
      action: 'DSAR_ERASED',
      severity: 'critical',
      targetEntity: 'user',
      targetId: u.id,
      previous: { username: u.username },
    });
    return { status: 'erased', ...result };
  }
}
