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

  @Get()
  list(
    @CurrentUser() u: AuthUser,
    @Query('action') action?: string,
    @Query('outcome') outcome?: string,
    @Query('userId') userId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: number,
  ) {
    return this.svc.list(u.tenantId, { action, outcome, userId, q, from, to, limit });
  }

  // Distinct action vocabulary for the viewer's filter dropdown.
  @Get('actions')
  actions(@CurrentUser() u: AuthUser) {
    return this.svc.actions(u.tenantId);
  }
}
