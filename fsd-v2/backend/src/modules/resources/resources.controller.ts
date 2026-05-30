import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  IsArray, IsBoolean, IsInt, IsNumber, IsObject, IsOptional, IsString,
  Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OperatingHours } from '../../common/operating-hours';
import { ResourcesService } from './resources.service';
import { CustomizationService } from '../customization/customization.service';
import { zonedTimeToUtc } from '../../common/tz';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class SubResourceDto {
  @IsOptional() @IsString() id?: string;
  @IsString() name!: string;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
}

class CustomFieldDto {
  @IsString() key!: string;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() type?: string;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) options?: string[];
}

// Per-resource overrides of the tenant workflow defaults. Every field is
// optional — an absent key inherits the tenant value. requiresApproval is
// deliberately a tri-state at the storage layer: absent = inherit, true =
// force approval, false = explicitly waive it even if the tenant default
// requires it. Whitelisting strips any unknown nested key so a client can't
// smuggle arbitrary data into the jsonb column.
class RuleOverridesDto {
  @IsOptional() @IsInt() @Min(1) minDurationMinutes?: number;
  @IsOptional() @IsInt() @Min(1) maxDurationMinutes?: number;
  @IsOptional() @IsInt() @Min(1) bookingHorizonDays?: number;
  @IsOptional() @IsInt() @Min(1) graceMinutes?: number;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
}

class ResourceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() region?: string;
  @IsOptional() @IsString() assetType?: string;
  @IsOptional() @IsInt() capacity?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() isRestricted?: boolean;
  @IsOptional() @IsBoolean() requiresApproval?: boolean;
  @IsOptional() @IsString() parentResourceId?: string;
  @IsOptional() @IsString() compositeMode?: string;
  @IsOptional() @IsString() departmentId?: string;

  // Booking model + pods.
  @IsOptional() @IsString() bookingMode?: string;
  @IsOptional() @IsInt() @Min(1) sharedCapacity?: number;

  // Operating hours — null/omitted means open 24h. Per-weekday schedule (or
  // legacy single window); kept as a loose object here and validated +
  // canonicalised in the service via normalizeOperatingHours so the dynamic
  // weekday keys survive the whitelisting ValidationPipe.
  @IsOptional() @IsObject()
  operatingHours?: OperatingHours | null;

  @IsOptional() @IsArray() @IsString({ each: true }) equipment?: string[];

  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CustomFieldDto)
  customFields?: CustomFieldDto[];

  // Per-resource workflow rule overrides (duration/horizon/grace/approval).
  // null = clear all overrides (inherit everything).
  @IsOptional() @IsObject() @ValidateNested() @Type(() => RuleOverridesDto)
  ruleOverrides?: RuleOverridesDto | null;

  // Default cost-center code billed for this resource's bookings.
  @IsOptional() @IsString() costCenterCode?: string | null;

  // Write-only: drives creation/soft-removal of child resources for a
  // splittable space. Not a column on the parent — handled in the service.
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => SubResourceDto)
  subResources?: SubResourceDto[];
}

class SearchQuery {
  @IsString() date!: string;          // YYYY-MM-DD
  @IsString() startTime!: string;     // HH:mm
  @IsString() endTime!: string;       // HH:mm
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() assetType?: string;
  @IsOptional() @Type(() => Number) @IsNumber() capacity?: number;
}

@ApiTags('resources')
@ApiBearerAuth()
@Controller('resources')
export class ResourcesPublicController {
  constructor(
    private readonly svc: ResourcesService,
    private readonly customization: CustomizationService,
  ) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }

  // Bookers' search endpoint — every authenticated user can hit this.
  // The PII-stripping policy is enforced by NOT joining bookings.
  @Get('search')
  async search(@CurrentUser() u: AuthUser, @Query() q: SearchQuery) {
    // Interpret the wall-clock window in the tenant's timezone so it lines up
    // with the true-UTC instants bookings are stored as — otherwise a 15:00
    // local search compared against a 15:00-local (07:00Z) booking never
    // overlaps and booked rooms look available (QA #1).
    const cust = await this.customization.get(u.tenantId);
    const tz = (cust as { timezone?: string }).timezone;
    const start = zonedTimeToUtc(q.date, q.startTime, tz);
    const end = zonedTimeToUtc(q.date, q.endTime, tz);
    return this.svc.findAvailable({
      tenantId: u.tenantId, location: q.location, assetType: q.assetType,
      capacity: q.capacity, start, end,
    });
  }
}

@ApiTags('admin / resources')
@ApiBearerAuth()
@Controller('admin/resources')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class ResourcesAdminController {
  constructor(private readonly svc: ResourcesService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.list(u.tenantId); }

  // Active child sub-resources of a splittable parent, so the editor can
  // re-hydrate the sub-resource list when reopening a composite parent.
  @Get(':id/children')
  children(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.children(u.tenantId, id);
  }

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: ResourceDto) {
    return this.svc.create(u.tenantId, dto);
  }

  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: ResourceDto) {
    return this.svc.update(u.tenantId, id, dto);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
