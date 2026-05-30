import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';
import { UsersService } from './users.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
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
  @IsOptional() @IsArray() @IsString({ each: true }) regionAccess?: string[];
  @IsOptional() @IsArray() @IsUUID('4', { each: true }) departmentIds?: string[];
}

@ApiTags('admin / users')
@ApiBearerAuth()
@Controller('admin/users')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class UsersController {
  constructor(private readonly svc: UsersService, private readonly audit: AuditService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }

  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.findById(u.tenantId, id);
  }

  @Post() async create(@CurrentUser() u: AuthUser, @Body() body: UpsertUserBody) {
    const created = await this.svc.create(u.tenantId, body);
    await this.audit.record(u, {
      action: 'USER_CREATED', severity: 'warning',
      targetEntity: 'user', targetId: created.id,
      next: { username: created.username, role: created.role },
    });
    return created;
  }

  @Put(':id') async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: UpsertUserBody) {
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

  @Delete(':id') @HttpCode(204) async deactivate(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.deactivate(u.tenantId, id);
    await this.audit.record(u, {
      action: 'USER_DEACTIVATED', severity: 'warning',
      targetEntity: 'user', targetId: id,
    });
  }
}
