import {
  Body, Controller, Delete, Get, Param, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { InvoicesService } from './invoices.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InvoiceStatus } from './invoice.entity';

class RunDto {
  @IsString() period!: string;     // YYYY-MM
  @IsOptional() @IsNumber() taxRate?: number;
}

@ApiTags('admin / invoices')
@ApiBearerAuth()
@Controller('admin/invoices')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class InvoicesAdminController {
  constructor(private readonly svc: InvoicesService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query('status') status?: InvoiceStatus) {
    return this.svc.list(u.tenantId, status);
  }
  @Get(':id') get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.get(u.tenantId, id);
  }
  @Post('run') run(@CurrentUser() u: AuthUser, @Body() dto: RunDto) {
    return this.svc.runRollup(u.tenantId, dto.period, dto.taxRate ?? 0);
  }
  @Post(':id/issue') issue(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.setStatus(u.tenantId, id, 'Issued');
  }
  @Post(':id/mark-paid') paid(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.setStatus(u.tenantId, id, 'Paid');
  }
  @Post(':id/cancel') cancel(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.setStatus(u.tenantId, id, 'Cancelled');
  }
  @Delete(':id') remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
