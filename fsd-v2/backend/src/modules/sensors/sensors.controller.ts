import {
  Body, Controller, Delete, Get, Headers, Param, Post, Put, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { SensorsService } from './sensors.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';

class EnrolDto {
  @IsString() deviceId!: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsString() label?: string;
}

class UpdateSensorDto {
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() resourceId?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class IngestDto {
  @IsNumber() occupancy!: number;
  @IsOptional() @IsISO8601() observedAt?: string;
  @IsOptional() @IsObject() extra?: Record<string, unknown>;
}

@ApiTags('sensors')
@Controller('sensors')
export class SensorsIngestController {
  constructor(private readonly svc: SensorsService) {}

  // Token-protected ingestion: no JWT, identity comes from
  // X-Device-Id / X-Device-Secret. @Public skips the global JwtAuthGuard.
  @Public()
  @Post('ingest')
  ingest(
    @Headers('x-device-id') deviceId: string,
    @Headers('x-device-secret') secret: string,
    @Body() dto: IngestDto,
  ) {
    return this.svc.ingest({
      deviceId, secret,
      occupancy: dto.occupancy,
      observedAt: dto.observedAt ? new Date(dto.observedAt) : undefined,
      extra: dto.extra,
    });
  }
}

@ApiTags('admin / sensors')
@ApiBearerAuth()
@Controller('admin/sensors')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class SensorsAdminController {
  constructor(private readonly svc: SensorsService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }
  // Enrol returns plaintext secret ONCE — caller must store it.
  @Post() enrol(@CurrentUser() u: AuthUser, @Body() dto: EnrolDto) {
    return this.svc.enrol(u.tenantId, dto);
  }
  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateSensorDto) {
    return this.svc.update(u.tenantId, id, dto);
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
  @Get('readings') recent(
    @CurrentUser() u: AuthUser,
    @Query('resourceId') resourceId: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.recent(u.tenantId, resourceId, limit ? parseInt(limit, 10) : 50);
  }
}
