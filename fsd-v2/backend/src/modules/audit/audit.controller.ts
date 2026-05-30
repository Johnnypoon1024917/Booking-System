import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('admin / audit')
@ApiBearerAuth()
@Controller('admin/audit')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query('limit') limit?: number) {
    return this.svc.list(u.tenantId, limit);
  }
}
