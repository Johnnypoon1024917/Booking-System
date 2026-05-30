import {
  Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsIn, IsString, MinLength } from 'class-validator';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_TEMPLATE_TYPES, NotificationTemplateType,
} from './notification-template.entity';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditService } from '../audit/audit.service';

class UpsertTemplateDto {
  @IsIn(NOTIFICATION_TEMPLATE_TYPES) templateType!: NotificationTemplateType;
  @IsString() @MinLength(1) subject!: string;
  @IsString() @MinLength(1) bodyTemplate!: string;
}

@ApiTags('admin / notification templates')
@ApiBearerAuth()
@Controller('admin/notification-templates')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class NotificationsController {
  constructor(
    private readonly svc: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listTemplates(u.tenantId);
  }

  @Put()
  async upsert(@CurrentUser() u: AuthUser, @Body() dto: UpsertTemplateDto) {
    const saved = await this.svc.upsertTemplate(u.tenantId, dto.templateType, dto.subject, dto.bodyTemplate);
    await this.audit.record(u, {
      action: 'NOTIFICATION_TEMPLATE_SAVED', severity: 'info',
      targetEntity: 'notification_template', targetId: saved.id,
      next: { templateType: dto.templateType, subject: dto.subject },
    });
    return saved;
  }

  @Delete(':id') @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const ok = await this.svc.deleteTemplate(u.tenantId, id);
    if (!ok) throw new NotFoundException('template not found');
    await this.audit.record(u, {
      action: 'NOTIFICATION_TEMPLATE_DELETED', severity: 'warning',
      targetEntity: 'notification_template', targetId: id,
    });
  }
}
