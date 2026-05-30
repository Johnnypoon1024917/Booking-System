import { BadRequestException, Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsString } from 'class-validator';
import { PushService } from './push.service';
import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { AdminRoles, RequireRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';

class SubscribeDto {
  @IsString() endpoint!: string;
  @IsObject() keys!: { p256dh: string; auth: string };
}
class UnsubscribeDto {
  @IsString() endpoint!: string;
}

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class PushController {
  constructor(private readonly svc: PushService) {}

  // VAPID public key is safe to expose unauthenticated — the SPA may
  // need it before the user is logged in (PWA setup screens).
  @Public()
  @Get('vapid-key')
  vapidKey() {
    return { publicKey: this.svc.publicKey };
  }

  @Post('subscribe')
  async subscribe(@CurrentUser() u: AuthUser, @Req() req: any, @Body() dto: SubscribeDto) {
    if (!dto.endpoint || !dto.keys?.p256dh || !dto.keys?.auth) {
      throw new BadRequestException('endpoint, keys.p256dh, keys.auth required');
    }
    await this.svc.subscribe(
      u.tenantId, u.id,
      dto.endpoint, dto.keys.p256dh, dto.keys.auth,
      req.headers['user-agent'] ?? '',
    );
    return { ok: true };
  }

  @Delete('unsubscribe')
  async unsubscribe(@CurrentUser() u: AuthUser, @Body() dto: UnsubscribeDto) {
    if (!dto.endpoint) throw new BadRequestException('endpoint required');
    await this.svc.unsubscribe(u.id, dto.endpoint);
    return { ok: true };
  }
}

@ApiTags('admin / push')
@ApiBearerAuth()
@Controller('admin/push')
@UseGuards(RolesGuard)
@RequireRoles(...AdminRoles)
export class PushAdminController {
  constructor(private readonly svc: PushService) {}

  // Sends a "Test notification" to all of the calling admin's own
  // subscriptions — handy for verifying the SW registration end-to-end.
  @Post('test')
  test(@CurrentUser() u: AuthUser) {
    return this.svc.sendToUser(u.tenantId, u.id, {
      title: 'FSD MRBS test notification',
      body: 'If you can see this, push delivery is working.',
      url: '/',
    });
  }
}
