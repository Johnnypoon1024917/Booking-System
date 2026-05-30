import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { BroadcastsService } from './broadcasts.service';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class BroadcastDto {
  @IsString() title!: string;
  @IsString() content!: string;
  @IsOptional() @IsString() severity?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsString() imageUrl?: string;
  @IsOptional() @IsString() startsAt?: string;
  @IsOptional() @IsString() endsAt?: string;
  @IsOptional() @IsObject() filters?: Record<string, any>;
}

@ApiTags('broadcasts')
@ApiBearerAuth()
@Controller('broadcasts')
export class BroadcastsPublicController {
  constructor(private readonly svc: BroadcastsService) {}

  // Lightweight: every authenticated user polls this for the banner.
  @Get() active(@CurrentUser() u: AuthUser) { return this.svc.findActive(u.tenantId); }
}

@ApiTags('admin / broadcasts')
@ApiBearerAuth()
@Controller('admin/broadcasts')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class BroadcastsAdminController {
  constructor(private readonly svc: BroadcastsService) {}

  @Get() list(@CurrentUser() u: AuthUser) { return this.svc.listAll(u.tenantId); }

  @Post() create(@CurrentUser() u: AuthUser, @Body() dto: BroadcastDto) {
    return this.svc.create(u.tenantId, u.id, dto);
  }

  @Put(':id') update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BroadcastDto) {
    return this.svc.update(u.tenantId, id, dto);
  }

  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
