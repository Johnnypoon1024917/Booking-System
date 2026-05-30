import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { ScimService } from './scim.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequireRoles, AdminRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class IssueDto { @IsOptional() @IsString() name?: string; }

// Admin UI endpoints for managing SCIM tokens. Lives inside the
// `api/v1` prefix and is guarded by the normal JWT + role guard.
@ApiTags('admin/scim')
@ApiBearerAuth()
@Controller('admin/scim/tokens')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class ScimAdminController {
  constructor(private readonly svc: ScimService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.tenantId);
  }

  // Returns the plaintext token in this response only — never again.
  @Post()
  @HttpCode(201)
  issue(@CurrentUser() u: AuthUser, @Body() body: IssueDto) {
    return this.svc.issue(u.tenantId, body.name || 'SCIM client');
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.revoke(u.tenantId, id);
  }
}
