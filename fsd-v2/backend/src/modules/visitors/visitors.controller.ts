import {
  Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString } from 'class-validator';
import { VisitorsService } from './visitors.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { VisitStatus } from './visit.entity';

class VisitDto {
  @IsString() visitorName!: string;
  @IsString() hostUserId!: string;
  @IsISO8601() expectedAt!: string;
  @IsOptional() @IsISO8601() expectedUntil?: string;
  @IsOptional() @IsString() bookingId?: string;
  @IsOptional() @IsString() visitorEmail?: string;
  @IsOptional() @IsString() visitorPhone?: string;
  @IsOptional() @IsString() visitorCompany?: string;
  @IsOptional() @IsString() purpose?: string;
  @IsOptional() @IsBoolean() ndaAccepted?: boolean;
  @IsOptional() @IsString() notes?: string;
}

// Lifecycle endpoints are open to any authenticated user — reception
// staff aren't always admins. Admin role is only required for the CRUD
// listing/edit screen.
@ApiTags('visitors')
@ApiBearerAuth()
@Controller('visitors')
export class VisitorsLifecycleController {
  constructor(private readonly svc: VisitorsService) {}
  @Post(':id/check-in') checkIn(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.checkIn(u.tenantId, id);
  }
  @Post(':id/check-out') checkOut(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.checkOut(u.tenantId, id);
  }
  @Post(':id/cancel') cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.cancel(u.tenantId, id);
  }
}

@ApiTags('admin / visitors')
@ApiBearerAuth()
@Controller('admin/visitors')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class VisitorsAdminController {
  constructor(private readonly svc: VisitorsService) {}

  @Get() list(
    @CurrentUser() u: AuthUser,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: VisitStatus,
  ) {
    return this.svc.list(
      u.tenantId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
      status,
    );
  }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: VisitDto) {
    return this.svc.create(u.tenantId, u.id, {
      ...dto,
      expectedAt: new Date(dto.expectedAt),
      expectedUntil: dto.expectedUntil ? new Date(dto.expectedUntil) : undefined,
    });
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: VisitDto) {
    return this.svc.update(u.tenantId, id, {
      ...dto,
      expectedAt: new Date(dto.expectedAt),
      expectedUntil: dto.expectedUntil ? new Date(dto.expectedUntil) : undefined,
    });
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
