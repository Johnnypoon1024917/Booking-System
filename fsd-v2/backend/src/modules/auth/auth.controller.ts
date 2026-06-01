import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { PushService } from '../push/push.service';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class LoginDto {
  @IsString() tenantSlug!: string;
  @IsString() username!: string;
  @IsString() @MinLength(1) password!: string;
}

class ChangePasswordDto {
  @IsString() changeToken!: string;
  @IsString() @MinLength(8) newPassword!: string;
}

class LogoutDto {
  // The logging-out device's current Web Push subscription endpoint, so we can
  // unbind it. Optional — a user without notifications enabled has none.
  @IsOptional() @IsString() pushEndpoint?: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly push: PushService,
  ) {}

  // 10 attempts / 5 min per IP — absorbs a fat-fingered password but stops
  // credential-stuffing and the bcrypt-per-attempt CPU amplifier.
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.auth.login(body.tenantSlug, body.username, body.password);
  }

  // Completes a forced first-login password reset. Public because the
  // caller only holds the short-lived change-token, not a session yet.
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('change-password')
  @HttpCode(200)
  changePassword(@Body() body: ChangePasswordDto) {
    return this.auth.changePassword(body.changeToken, body.newPassword);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  // Logout. The JWT itself is stateless (the client discards it), but on a
  // SHARED device the browser's push subscription would otherwise survive and
  // keep delivering THIS user's notifications to whoever logs in next — a
  // confidentiality breach (e.g. a "HR Disciplinary Review" approval popping up
  // for the next person at a front-desk PC). So we actively delete this device's
  // push subscription row here, before the session is dropped client-side.
  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: AuthUser, @Body() body: LogoutDto) {
    if (body.pushEndpoint) {
      await this.push.unsubscribe(user.id, body.pushEndpoint);
    }
    return { ok: true };
  }
}
