import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';
import { FloorPlansService } from './floor-plans.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class FloorPlanDto {
  @IsString() name!: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsArray() shapes?: unknown[];
  @IsOptional() @IsArray() pins?: unknown[];
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

class DuplicateDto {
  @IsString() name!: string;
}

@ApiTags('floor-plans')
@ApiBearerAuth()
@Controller('floor-plans')
export class FloorPlansPublicController {
  constructor(private readonly svc: FloorPlansService) {}
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
}

@ApiTags('admin / floor-plans')
@ApiBearerAuth()
@Controller('admin/floor-plans')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class FloorPlansAdminController {
  constructor(private readonly svc: FloorPlansService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(u.tenantId, id);
  }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: FloorPlanDto) {
    return this.svc.create(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: FloorPlanDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
  @Post(':id/set-default') setDefault(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.setDefault(u.tenantId, id);
  }
  @Post(':id/duplicate') duplicate(
    @CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: DuplicateDto,
  ) {
    return this.svc.duplicate(u.tenantId, id, dto.name);
  }
}
