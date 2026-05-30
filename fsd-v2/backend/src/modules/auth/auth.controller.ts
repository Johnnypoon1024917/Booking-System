import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { AuthService } from './auth.service';
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

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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
}
