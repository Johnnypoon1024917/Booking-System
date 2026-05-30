import {
  BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMinSize, IsArray, IsBoolean, IsOptional, IsString, IsUrl,
} from 'class-validator';
import { WebhooksService } from './webhooks.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Perm } from '../permissions/permission-catalog';
import { AuditService } from '../audit/audit.service';

class CreateWebhookDto {
  @IsUrl({ require_protocol: true, require_tld: false }) targetURL!: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @IsString({ each: true })
  events?: string[];
}
class UpdateWebhookDto {
  @IsOptional() @IsUrl({ require_protocol: true, require_tld: false }) targetURL?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) events?: string[];
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('admin / webhooks')
@ApiBearerAuth()
@Controller('admin/webhooks')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
@RequirePermission(Perm.WebhookManage)
export class WebhooksController {
  constructor(
    private readonly svc: WebhooksService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.tenantId);
  }

  @Get('deliveries')
  deliveries(@CurrentUser() u: AuthUser, @Query('limit') limit?: string) {
    return this.svc.listDeliveries(u.tenantId, limit ? parseInt(limit, 10) : undefined);
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateWebhookDto) {
    try {
      const created = await this.svc.create(u.tenantId, dto);
      await this.audit.record(u, {
        action: 'WEBHOOK_CREATED', severity: 'warning',
        targetEntity: 'webhook', targetId: created.id,
        next: { targetURL: created.targetURL, events: created.events },
      });
      return created;
    } catch (e: any) {
      throw new BadRequestException(`targetURL rejected: ${e?.message || e}`);
    }
  }

  @Put(':id') @HttpCode(204)
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateWebhookDto) {
    try {
      await this.svc.update(u.tenantId, id, dto);
    } catch (e: any) {
      if (e?.status === 404) throw e;
      throw new BadRequestException(`update rejected: ${e?.message || e}`);
    }
    await this.audit.record(u, {
      action: 'WEBHOOK_UPDATED', severity: 'info',
      targetEntity: 'webhook', targetId: id, next: dto,
    });
  }

  @Delete(':id') @HttpCode(204)
  async delete(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.delete(u.tenantId, id);
    await this.audit.record(u, {
      action: 'WEBHOOK_DELETED', severity: 'warning',
      targetEntity: 'webhook', targetId: id,
    });
  }
}
