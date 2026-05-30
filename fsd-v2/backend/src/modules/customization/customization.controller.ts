import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CustomizationService } from './customization.service';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

@ApiTags('customization')
@ApiBearerAuth()
@Controller()
export class CustomizationController {
  constructor(private readonly svc: CustomizationService) {}

  // Public to all authenticated users — the SPA reads this on boot
  // to render branding / locale / sidebar modules.
  @Get('customization')
  get(@CurrentUser() u: AuthUser) { return this.svc.get(u.tenantId); }

  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @Put('admin/customization')
  save(@CurrentUser() u: AuthUser, @Body() data: Record<string, any>) {
    return this.svc.save(u.tenantId, data);
  }
}
