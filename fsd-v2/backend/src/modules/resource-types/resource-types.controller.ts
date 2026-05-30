import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString } from 'class-validator';
import { ResourceTypesService } from './resource-types.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class ResourceTypeDto {
  @IsString() key!: string;
  @IsString() label!: string;
  @IsOptional() @IsString() icon?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsInt() defaultCapacity?: number;
  @IsOptional() @IsString() defaultBookingMode?: string;
  @IsOptional() @IsBoolean() defaultRequiresApproval?: boolean;
  @IsOptional() @IsInt() displayOrder?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

@ApiTags('resource-types')
@ApiBearerAuth()
@Controller('resource-types')
export class ResourceTypesPublicController {
  constructor(private readonly svc: ResourceTypesService) {}
  // Bookers need this to render booking forms.
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
}

@ApiTags('admin / resource-types')
@ApiBearerAuth()
@Controller('admin/resource-types')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class ResourceTypesAdminController {
  constructor(private readonly svc: ResourceTypesService) {}
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: ResourceTypeDto) {
    return this.svc.create(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResourceTypeDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
