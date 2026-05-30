import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApprovalsService } from './approvals.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AuditService } from '../audit/audit.service';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ApprovalLevel, ApprovalScopeType } from './approval-rule.entity';

class DecideDto {
  @IsIn(['approved', 'rejected']) status!: 'approved' | 'rejected';
  @IsOptional() @IsString() reason?: string;
}
class DelegateDto {
  @IsString() to_user_id!: string;
  @IsOptional() @IsString() reason?: string;
}

class LevelDto implements ApprovalLevel {
  @IsString() name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) approver_user_ids?: string[];
  @IsOptional() @IsString() approver_role?: string;
  @IsOptional() @IsString() min_grade?: string;
  @IsOptional() @IsInt() @Min(0) auto_after_hours?: number;
  @IsOptional() @IsArray() @IsInt({ each: true }) dependencies?: number[];
  @IsOptional() @IsBoolean() parallel?: boolean;
}
class RuleDto {
  @IsString() name!: string;
  @IsIn(['asset_type', 'resource', 'department', 'tenant']) scopeType!: ApprovalScopeType;
  @IsOptional() @IsString() scopeValue?: string;
  @IsOptional() @IsInt() @Min(1) priority?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsArray() @ArrayMaxSize(20)
  @ValidateNested({ each: true }) @Type(() => LevelDto)
  levels!: LevelDto[];
}

@ApiTags('approvals')
@ApiBearerAuth()
@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly svc: ApprovalsService, private readonly audit: AuditService) {}

  // Inbox: bookings the current user can act on.
  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listPendingForApprover(u);
  }

  @Get(':bookingId/chain')
  chain(@CurrentUser() u: AuthUser, @Param('bookingId') id: string) {
    return this.svc.listChain(u.tenantId, id);
  }

  @Post(':bookingId/approve')
  async approve(@CurrentUser() u: AuthUser, @Param('bookingId') id: string, @Body() body: { reason?: string }) {
    const out = await this.svc.decide(u, id, { status: 'approved', reason: body?.reason });
    await this.audit.record(u, {
      action: 'ACTION_APPROVED', severity: 'warning',
      targetEntity: 'booking', targetId: id,
      next: { decision: 'approved', chained: out.chained, reason: body?.reason ?? '' },
    });
    return out;
  }

  @Post(':bookingId/reject')
  async reject(@CurrentUser() u: AuthUser, @Param('bookingId') id: string, @Body() body: DecideDto) {
    const out = await this.svc.decide(u, id, { status: 'rejected', reason: body.reason });
    await this.audit.record(u, {
      action: 'ACTION_REJECTED', severity: 'warning',
      targetEntity: 'booking', targetId: id,
      next: { decision: 'rejected', chained: out.chained, reason: body.reason ?? '' },
    });
    return out;
  }

  @Post(':bookingId/delegate')
  async delegate(@CurrentUser() u: AuthUser, @Param('bookingId') id: string, @Body() body: DelegateDto) {
    await this.svc.delegate(u, id, body.to_user_id, body.reason ?? '');
    await this.audit.record(u, {
      action: 'ACTION_APPROVED', severity: 'warning',
      targetEntity: 'booking', targetId: id,
      next: { delegated_to: body.to_user_id, reason: body.reason ?? '' },
    });
    return { status: 'delegated' };
  }
}

// Admin CRUD over approval rules. Split into its own controller so the
// /admin/approval-rules prefix matches v1 and the RolesGuard scope is
// narrow (every action here requires admin).
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
@Controller('admin/approval-rules')
export class AdminApprovalRulesController {
  constructor(private readonly svc: ApprovalsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.listRules(u.tenantId);
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() body: RuleDto) {
    return this.svc.saveRule(u.tenantId, body as any);
  }

  @Put(':id')
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: RuleDto) {
    return this.svc.saveRule(u.tenantId, { ...(body as any), id });
  }

  @Delete(':id') @HttpCode(204)
  remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.deleteRule(u.tenantId, id);
  }
}
