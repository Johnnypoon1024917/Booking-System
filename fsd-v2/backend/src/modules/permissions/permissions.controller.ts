import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { PermissionsService } from './permissions.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Perm } from './permission-catalog';
import { AuditService } from '../audit/audit.service';

class SetPermissionsDto {
  @IsArray() @IsString({ each: true }) permissions!: string[];
  // Optimistic-concurrency token from the last GET. When present the
  // service rejects the write (409) if the role changed in the meantime.
  @IsOptional() @IsString() expectedVersion?: string;
}
class CreateRoleDto {
  @IsString() role!: string;
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

  // Create a custom role (e.g. "Catering Staff"). Same permission gate as
  // editing the matrix — defining a new role is an authorization-model change.
  @Post()
  @RequirePermission(Perm.PermissionManage)
  async create(@CurrentUser() u: AuthUser, @Body() body: CreateRoleDto) {
    const created = await this.svc.createRole(u.tenantId, body.role);
    await this.audit.record(u, {
      action: 'PERMISSION_CHANGED', severity: 'warning',
      targetEntity: 'role', targetId: created.role,
      next: { created: true },
    });
    return created;
  }

  // Delete a custom role. Built-in roles and roles still in use are rejected
  // by the service (403 / 409 respectively).
  @Delete(':role')
  @RequirePermission(Perm.PermissionManage)
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('role') role: string) {
    await this.svc.deleteRole(u.tenantId, role);
    await this.audit.record(u, {
      action: 'PERMISSION_CHANGED', severity: 'warning',
      targetEntity: 'role', targetId: role,
      next: { deleted: true },
    });
  }

  // Editing the matrix itself is the most sensitive action — gate it on
  // permission.manage so a Room Admin / Secretary (admin-tier by role but
  // without this permission) can't rewrite the authorization model.
  @Put(':role')
  @RequirePermission(Perm.PermissionManage)
  async set(
    @CurrentUser() u: AuthUser,
    @Param('role') role: string,
    @Body() body: SetPermissionsDto,
  ) {
    const { previous, next, version } = await this.svc.setRole(
      u.tenantId, role, body.permissions, body.expectedVersion,
      // Pass the editor so the service can block them granting a permission key
      // they don't already hold (row-level privilege-escalation guard).
      { role: u.role },
    );
    await this.audit.record(u, {
      action: 'PERMISSION_CHANGED', severity: 'warning',
      targetEntity: 'role', targetId: role,
      previous: { permissions: previous },
      next: { permissions: next },
    });
    // Return the new version so the client can keep editing without a full
    // reload (the next save echoes this back as expectedVersion).
    return { version };
  }
}
