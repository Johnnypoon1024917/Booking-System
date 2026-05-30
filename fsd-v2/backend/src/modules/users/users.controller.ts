import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Perm } from '../permissions/permission-catalog';
import { AuditService } from '../audit/audit.service';

class UpsertUserBody {
  @IsString() username!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() role!: string;
  @IsOptional() @IsString() password?: string;
  @IsOptional() @IsBoolean() mustChangePassword?: boolean;
  @IsOptional() @IsString() dn?: string;
  @IsOptional() @IsString() grade?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  // Line manager for dynamic approval routing. '' clears it. @IsUUID rejects
  // anything that isn't a real id (an empty string is normalised to null below).
  @IsOptional() @IsString() managerId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) regionAccess?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) departmentIds?: string[];
  // Preferred language for system emails/push. Lenient on input (SSO variants
  // like zh-TW are accepted); the service coerces to a supported locale.
  @IsOptional() @IsString() locale?: string;
}

@ApiTags('admin / users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class UsersController {
  constructor(private readonly svc: UsersService, private readonly audit: AuditService) {}

  // Backward-compatible directory listing. With no pagination params we
  // return the full array (pickers/dropdowns across the app rely on that
  // shape). When `page` or `search` is supplied we return a paginated
  // envelope { items, total, page, pageSize } so the admin table never
  // pulls an entire government-sized directory into the DOM at once.
  @Get() list(
    @CurrentUser() u: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
  ) {
    if (page === undefined && search === undefined) {
      return this.svc.list(u.tenantId);
    }
    const p = Math.max(parseInt(page ?? '1', 10) || 1, 1);
    const size = Math.min(Math.max(parseInt(pageSize ?? '25', 10) || 25, 1), 100);
    return this.svc.listPaged(u.tenantId, { page: p, pageSize: size, search: (search ?? '').trim() });
  }

  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.findById(u.tenantId, id);
  }

  @Post() @RequirePermission(Perm.UserCreate)
  async create(@CurrentUser() u: AuthUser, @Body() body: UpsertUserBody) {
    const created = await this.svc.create(u.tenantId, body);
    await this.audit.record(u, {
      action: 'USER_CREATED', severity: 'warning',
      targetEntity: 'user', targetId: created.id,
      next: { username: created.username, role: created.role },
    });
    return created;
  }

  @Put(':id') @RequirePermission(Perm.UserUpdate)
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: UpsertUserBody) {
    const before = await this.svc.findById(u.tenantId, id);
    const updated = await this.svc.update(u.tenantId, id, body);
    await this.audit.record(u, {
      action: 'USER_UPDATED', severity: 'warning',
      targetEntity: 'user', targetId: id,
      previous: { role: before.role, isActive: before.isActive },
      next: { role: updated.role, isActive: updated.isActive },
    });
    if (before.role !== updated.role) {
      await this.audit.record(u, {
        action: 'ROLE_CHANGED', severity: 'critical',
        targetEntity: 'user', targetId: id,
        previous: { role: before.role }, next: { role: updated.role },
      });
    }
    return updated;
  }

  @Delete(':id') @HttpCode(204) @RequirePermission(Perm.UserDeactivate)
  async deactivate(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.deactivate(u.tenantId, id);
    await this.audit.record(u, {
      action: 'USER_DEACTIVATED', severity: 'warning',
      targetEntity: 'user', targetId: id,
    });
  }
}
