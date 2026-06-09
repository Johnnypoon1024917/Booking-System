import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsIn, IsOptional, IsString, IsUUID } from 'class-validator';
import { LocationGroupsService } from './location-groups.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class LocationGroupDto {
  @IsString() name!: string;
  @IsOptional() @IsString() filterBy?: string;
  // approvers/locations are SPA-owned JSONB blobs (object shapes vary), so they
  // stay loose arrays. memberIds is an access-control list of user ids, so we
  // validate each element is a UUID (AUD-013).
  @IsOptional() @IsArray() approvers?: unknown[];
  @IsOptional() @IsArray() locations?: unknown[];
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) memberIds?: string[];
  @IsOptional() @IsIn(['Active', 'Inactive', 'Archived']) status?: string;
}

@ApiTags('admin / location-groups')
@ApiBearerAuth()
@Controller('admin/location-groups')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class LocationGroupsController {
  constructor(private readonly svc: LocationGroupsService) {}
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: LocationGroupDto) {
    return this.svc.create(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: LocationGroupDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
