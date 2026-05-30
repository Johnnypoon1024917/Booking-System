import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';
import { CredentialService } from './credential.service';
import { GraphService } from '../graph/graph.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditService } from '../audit/audit.service';

class SaveCredentialDto {
  @IsOptional() @IsString() azureTenantID?: string;
  @IsOptional() @IsString() clientID?: string;
  @IsOptional() @IsString() clientSecret?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
class SaveMailboxDto {
  @IsUUID() resourceId!: string;
  @IsString() mailboxUPN!: string;
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

// AdminIntegrationsController — CRUD + live test for integration creds
// and the resource ↔ M365 mailbox map.
//
//   GET    /api/v1/admin/integrations                    list providers
//   PUT    /api/v1/admin/integrations/:provider          create / update
//   DELETE /api/v1/admin/integrations/:provider
//   POST   /api/v1/admin/integrations/:provider/test     live token check
//
//   GET    /api/v1/admin/integrations/mailboxes
//   PUT    /api/v1/admin/integrations/mailboxes          { resourceId, mailboxUPN }
//   DELETE /api/v1/admin/integrations/mailboxes/:rid
//
// 'mailboxes' is reserved at the provider slot — every other value is
// treated as a provider id.
const VALID_PROVIDERS = new Set(['microsoft', 'google', 'zoom', 'teams-bot']);

@ApiTags('admin / integrations')
@ApiBearerAuth()
@Controller('admin/integrations')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class IntegrationsController {
  constructor(
    private readonly creds: CredentialService,
    private readonly graph: GraphService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.creds.list(u.tenantId);
  }

  @Get('mailboxes')
  mailboxes(@CurrentUser() u: AuthUser) {
    return this.creds.listMailboxes(u.tenantId);
  }

  @Put('mailboxes') @HttpCode(204)
  async saveMailbox(@CurrentUser() u: AuthUser, @Body() dto: SaveMailboxDto) {
    const saved = await this.creds.saveMailbox(u.tenantId, dto);
    // Best-effort Graph subscription ensure — failures don't block save;
    // the hourly cron will retry.
    this.graph.ensureSubscription(u.tenantId, saved.mailboxUPN).catch(() => undefined);
    await this.audit.record(u, {
      action: 'INTEGRATION_MAILBOX_MAPPED', severity: 'info',
      targetEntity: 'integration_mailbox', targetId: saved.id,
      next: { mailboxUPN: saved.mailboxUPN, resourceId: saved.resourceId },
    });
  }

  @Delete('mailboxes/:rid') @HttpCode(204)
  async deleteMailbox(@CurrentUser() u: AuthUser, @Param('rid') rid: string) {
    const removed = await this.creds.deleteMailbox(rid);
    if (removed) {
      this.graph.removeSubscription(u.tenantId, removed.mailboxUPN).catch(() => undefined);
      await this.audit.record(u, {
        action: 'INTEGRATION_MAILBOX_UNMAPPED', severity: 'info',
        targetEntity: 'integration_mailbox', targetId: removed.id,
      });
    }
  }

  @Put(':provider') @HttpCode(204)
  async save(@CurrentUser() u: AuthUser, @Param('provider') provider: string, @Body() dto: SaveCredentialDto) {
    if (!VALID_PROVIDERS.has(provider)) throw new BadRequestException('unknown provider');
    await this.creds.save(u.tenantId, provider, dto);
    await this.audit.record(u, {
      action: 'INTEGRATION_CONFIGURED', severity: 'warning',
      targetEntity: 'integration', targetId: provider,
      next: { provider, isActive: dto.isActive ?? true },
    });
  }

  @Delete(':provider') @HttpCode(204)
  async delete(@CurrentUser() u: AuthUser, @Param('provider') provider: string) {
    await this.creds.delete(u.tenantId, provider);
    await this.audit.record(u, {
      action: 'INTEGRATION_REMOVED', severity: 'warning',
      targetEntity: 'integration', targetId: provider,
    });
  }

  @Post(':provider/test')
  async test(@CurrentUser() u: AuthUser, @Param('provider') provider: string) {
    if (provider !== 'microsoft') {
      throw new BadRequestException('live test only supported for microsoft');
    }
    const cred = await this.creds.getDecrypted(u.tenantId, provider);
    if (!cred) throw new BadRequestException('credentials not configured');
    try {
      await this.graph.testConnection(cred.azureTenantID, cred.clientID, cred.clientSecret);
      await this.creds.updateTestResult(u.tenantId, provider, true, '');
      return { ok: true };
    } catch (e: any) {
      const msg = String(e?.message || e);
      await this.creds.updateTestResult(u.tenantId, provider, false, msg);
      return { ok: false, error: msg };
    }
  }
}
