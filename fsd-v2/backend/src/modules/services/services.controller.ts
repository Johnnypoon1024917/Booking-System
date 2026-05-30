import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ServicesService } from './services.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class ServiceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() categoryId?: string;
  @IsOptional() @IsInt() @Min(0) priceCents?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class AttachServiceDto {
  @IsString() serviceId!: string;
  @IsOptional() @IsInt() @Min(1) quantity?: number;
  @IsOptional() @IsString() note?: string;
}

@ApiTags('services')
@ApiBearerAuth()
@Controller('services')
export class ServicesPublicController {
  constructor(private readonly svc: ServicesService) {}
  // Active service catalog for the booking form.
  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
}

@ApiTags('bookings / services')
@ApiBearerAuth()
@Controller('bookings/:bookingId/services')
export class BookingServicesController {
  constructor(private readonly svc: ServicesService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Param('bookingId') bookingId: string) {
    return this.svc.listForBooking(u.tenantId, bookingId);
  }
  @Post() attach(
    @CurrentUser() u: AuthUser,
    @Param('bookingId') bookingId: string,
    @Body() dto: AttachServiceDto,
  ) {
    return this.svc.attachToBooking(u.tenantId, bookingId, dto.serviceId, dto.quantity ?? 1, dto.note ?? '');
  }
  @Delete(':id') detach(
    @CurrentUser() u: AuthUser,
    @Param('bookingId') bookingId: string,
    @Param('id') id: string,
  ) {
    return this.svc.detachFromBooking(u.tenantId, bookingId, id);
  }
}

@ApiTags('admin / services')
@ApiBearerAuth()
@Controller('admin/services')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class ServicesAdminController {
  constructor(private readonly svc: ServicesService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: ServiceDto) {
    return this.svc.create(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ServiceDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
