import { Body, Controller, Get, Headers, HttpCode, Ip, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
import { PushService } from '../push/push.service';
import { AuditService } from '../audit/audit.service';
import { PermissionsService } from '../permissions/permissions.service';
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
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
  ) {}

  // 10 attempts / 5 min per IP — absorbs a fat-fingered password but stops
  // credential-stuffing and the bcrypt-per-attempt CPU amplifier.
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('login')
  @HttpCode(200)
  async login(@Body() body: LoginDto, @Ip() ip: string, @Headers('user-agent') ua?: string) {
    // Authentication is the single most important thing to audit. We log every
    // outcome here (not via the global interceptor) because the username and
    // tenant must be captured even when the credentials are wrong — and a
    // failed login throws before any handler-level record could run.
    try {
      const result = await this.auth.login(body.tenantSlug, body.username, body.password);
      const ok = !!result.accessToken;
      await this.audit.write({
        tenantId: result.user?.tenantId,
        userId: result.user?.id,
        username: body.username,
        action: ok ? 'LOGIN_SUCCESS' : result.requiresMfa ? 'LOGIN_MFA_CHALLENGE' : 'LOGIN_PASSWORD_CHANGE_REQUIRED',
        severity: 'info', outcome: 'success',
        method: 'POST', path: '/api/v1/auth/login', ip, userAgent: ua,
        next: { tenantSlug: body.tenantSlug },
      });
      return result;
    } catch (err) {
      await this.audit.write({
        username: body.username,
        action: 'LOGIN_FAILED', severity: 'warning', outcome: 'denied',
        method: 'POST', path: '/api/v1/auth/login', ip, userAgent: ua,
        next: { tenantSlug: body.tenantSlug, reason: 'invalid credentials' },
      });
      throw err;
    }
  }

  // Completes a forced first-login password reset. Public because the
  // caller only holds the short-lived change-token, not a session yet.
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('change-password')
  @HttpCode(200)
  async changePassword(@Body() body: ChangePasswordDto, @Ip() ip: string, @Headers('user-agent') ua?: string) {
    try {
      const result = await this.auth.changePassword(body.changeToken, body.newPassword);
      await this.audit.write({
        tenantId: result.user?.tenantId,
        userId: result.user?.id,
        username: result.user?.username ?? 'unknown',
        action: 'PASSWORD_CHANGED', severity: 'warning', outcome: 'success',
        method: 'POST', path: '/api/v1/auth/change-password', ip, userAgent: ua,
      });
      return result;
    } catch (err) {
      await this.audit.write({
        username: 'unknown',
        action: 'PASSWORD_CHANGE_FAILED', severity: 'warning', outcome: 'failure',
        method: 'POST', path: '/api/v1/auth/change-password', ip, userAgent: ua,
      });
      throw err;
    }
  }

  // The SPA hydrates the session from here on every boot. We attach the user's
  // effective permission keys so the client can gate navigation/routes on
  // fine-grained permissions (e.g. report.view) rather than coarse role checks —
  // the backend guards remain the authoritative enforcement.
  @ApiBearerAuth()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const permissions = await this.permissions.effectivePermissions(user.tenantId, user.role);
    return { ...user, permissions };
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
  async logout(
    @CurrentUser() user: AuthUser,
    @Body() body: LogoutDto,
    @Ip() ip: string,
    @Headers('user-agent') ua?: string,
  ) {
    if (body.pushEndpoint) {
      await this.push.unsubscribe(user.id, body.pushEndpoint);
    }
    await this.audit.write({
      tenantId: user.tenantId, userId: user.id, username: user.username,
      action: 'LOGOUT', severity: 'info', outcome: 'success',
      method: 'POST', path: '/api/v1/auth/logout', ip, userAgent: ua,
    });
    return { ok: true };
  }
}
