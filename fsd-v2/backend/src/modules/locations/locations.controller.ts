import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { LocationsService } from './locations.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class LocationDto {
  @IsString() name!: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsObject() address?: Record<string, unknown>;
}

@ApiTags('locations')
@ApiBearerAuth()
@Controller('locations')
export class LocationsPublicController {
  constructor(private readonly svc: LocationsService) {}
  // Any authenticated user needs the list to populate booking filters.
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
}

@ApiTags('admin / locations')
@ApiBearerAuth()
@Controller('admin/locations')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class LocationsAdminController {
  constructor(private readonly svc: LocationsService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: LocationDto) {
    return this.svc.create(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: LocationDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
