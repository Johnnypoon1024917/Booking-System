import {
  Body, Controller, Get, HttpCode, Param, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsString } from 'class-validator';
import { PermissionsService } from './permissions.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Perm } from './permission-catalog';
import { AuditService } from '../audit/audit.service';

class SetPermissionsDto {
  @IsArray() @IsString({ each: true }) permissions!: string[];
}

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
@Controller('admin/permissions')
export class PermissionsController {
  constructor(private readonly svc: PermissionsService, private readonly audit: AuditService) {}

  @Get()
  get(@CurrentUser() u: AuthUser) {
    return this.svc.get(u.tenantId);
  }

  // Editing the matrix itself is the most sensitive action — gate it on
  // permission.manage so a Room Admin / Secretary (admin-tier by role but
  // without this permission) can't rewrite the authorization model.
  @Put(':role') @HttpCode(204)
  @RequirePermission(Perm.PermissionManage)
  async set(
    @CurrentUser() u: AuthUser,
    @Param('role') role: string,
    @Body() body: SetPermissionsDto,
  ) {
    const { previous, next } = await this.svc.setRole(u.tenantId, role, body.permissions);
    await this.audit.record(u, {
      action: 'PERMISSION_CHANGED', severity: 'warning',
      targetEntity: 'role', targetId: role,
      previous: { permissions: previous },
      next: { permissions: next },
    });
  }
}
