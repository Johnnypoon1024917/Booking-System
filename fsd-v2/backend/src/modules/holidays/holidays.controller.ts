import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { HolidaysService } from './holidays.service';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class HolidayDto {
  @IsString() holidayDate!: string;
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsBoolean() isBlocker?: boolean;
}

@ApiTags('admin / holidays')
@ApiBearerAuth()
@Controller('admin/holidays')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class HolidaysAdminController {
  constructor(private readonly svc: HolidaysService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: HolidayDto) {
    return this.svc.create(u.tenantId, u.id, dto);
  }

  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: HolidayDto) {
    return this.svc.update(u.tenantId, id, dto);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }

  // Manually trigger a gov.hk sync. Scoped to the admin's tenant.
  @Post('sync-hk') syncHK(
    @CurrentUser() u: AuthUser,
    @Query('locale') locale?: string,
  ) {
    return this.svc.syncFromGovHK(u.tenantId, u.id, locale || 'en');
  }
}
