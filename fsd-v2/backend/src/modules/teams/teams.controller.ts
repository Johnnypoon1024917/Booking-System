import {
  Body, Controller, Get, HttpCode, Post, Req, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { IsObject, IsOptional, IsString, IsUUID } from 'class-validator';
import { TeamsService } from './teams.service';
import { Public } from '../../common/decorators/public.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class NotifyDto {
  @IsUUID() userId!: string;
  @IsString() text!: string;
  @IsOptional() @IsObject() card?: Record<string, any>;
}

// TeamsController — exposes the Bot Framework messaging endpoint plus
// admin "send proactive notification" helpers.
//
//   GET  /api/v1/integrations/teams/manifest    download manifest (public)
//   POST /api/v1/integrations/teams/messages    bot framework webhook (public, JWT-validated)
//   POST /api/v1/admin/teams/notify             admin-triggered proactive send
@ApiTags('integrations / teams')
@Controller('integrations/teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Public()
  @Get('manifest')
  manifest() {
    return this.teams.manifest();
  }

  // Inbound activity webhook. Path is registered as Public because the
  // caller is Microsoft's bot service, not an authenticated user — we
  // validate the bearer JWT against MS's keys inside the service.
  @Public()
  @Post('messages') @HttpCode(200)
  async messages(@Body() body: any, @Req() req: Request) {
    await this.teams.validateInbound(req.headers['authorization'] || '', body);
    // Capture conversation ref for future proactive sends. We don't have
    // a v2 userId at this point — only the AAD object id — so the link
    // happens later when the user signs into the SPA. For now we no-op
    // the upsert until a /link endpoint connects identities.
    return { type: 'message', text: 'Hi — open the FSD MRBS app to manage bookings.' };
  }
}

@ApiTags('admin / teams')
@ApiBearerAuth()
@Controller('admin/teams')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class AdminTeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Post('notify') @HttpCode(202)
  async notify(@CurrentUser() _u: AuthUser, @Body() dto: NotifyDto) {
    try {
      await this.teams.proactiveSend(dto.userId, dto.text, dto.card);
      return { status: 'sent' };
    } catch (e: any) {
      return { status: 'failed', error: String(e?.message || e) };
    }
  }
}
