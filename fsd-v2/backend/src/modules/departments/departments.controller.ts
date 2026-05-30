import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';
import { DepartmentsService } from './departments.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class DepartmentDto {
  @IsString() name!: string;
  @IsOptional() @IsString() code?: string;
  @IsOptional() @IsUUID() parentId?: string;
}

@ApiTags('admin / departments')
@ApiBearerAuth()
@Controller('admin/departments')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class DepartmentsController {
  constructor(private readonly svc: DepartmentsService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: DepartmentDto) {
    return this.svc.create(u.tenantId, dto);
  }

  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DepartmentDto) {
    return this.svc.update(u.tenantId, id, dto);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
