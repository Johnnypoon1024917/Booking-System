import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { MfaService } from './mfa.service';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class CodeDto {
  @IsString() @MinLength(4) code!: string;
}
class LoginVerifyDto {
  @IsString() mfaToken!: string;
  @IsString() @MinLength(4) code!: string;
}

// All authenticated endpoints share the standard JWT auth guard;
// `/login-verify` is @Public() because the caller only has the
// intermediate mfaToken at that point, not a session JWT.
@ApiTags('mfa')
@Controller('mfa')
@ApiBearerAuth()
export class MfaController {
  constructor(private readonly mfa: MfaService) {}

  @Get('status')
  status(@CurrentUser() u: AuthUser) {
    return this.mfa.status(u.id, u.tenantId);
  }

  @Post('enroll')
  @HttpCode(200)
  enroll(@CurrentUser() u: AuthUser) {
    return this.mfa.enroll(u.id, u.tenantId);
  }

  @Post('verify')
  @HttpCode(200)
  verify(@CurrentUser() u: AuthUser, @Body() body: CodeDto) {
    return this.mfa.verify(u.id, u.tenantId, body.code);
  }

  @Delete('disable')
  @HttpCode(200)
  disable(@CurrentUser() u: AuthUser, @Body() body: CodeDto) {
    return this.mfa.disable(u.id, u.tenantId, body.code);
  }

  // Tighter than login: a 6-digit TOTP has only 1M values, so cap brute-force
  // attempts hard — 5 tries / 5 min per IP.
  @Public()
  @RateLimit({ limit: 5, windowMs: 5 * 60_000 })
  @Post('login-verify')
  @HttpCode(200)
  loginVerify(@Body() body: LoginVerifyDto) {
    return this.mfa.verifyLogin(body.mfaToken, body.code);
  }
}
