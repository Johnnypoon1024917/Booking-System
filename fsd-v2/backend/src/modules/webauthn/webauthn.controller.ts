import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { WebauthnService } from './webauthn.service';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Tenant } from '../tenants/tenant.entity';

class RegisterFinishDto {
  @IsOptional() @IsString() nickname?: string;
  @IsObject() response!: any;
}
class LoginStartDto {
  @IsString() tenantSlug!: string;
  @IsString() username!: string;
}
class LoginFinishDto {
  @IsString() tenantSlug!: string;
  @IsString() username!: string;
  @IsObject() response!: any;
}

@ApiTags('webauthn')
@Controller('webauthn')
@ApiBearerAuth()
export class WebauthnController {
  constructor(
    private readonly svc: WebauthnService,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
  ) {}

  @Post('register-start')
  @HttpCode(200)
  registerStart(@CurrentUser() u: AuthUser) {
    return this.svc.registerStart(u.id, u.tenantId);
  }

  @Post('register-finish')
  @HttpCode(200)
  registerFinish(@CurrentUser() u: AuthUser, @Body() body: RegisterFinishDto) {
    return this.svc.registerFinish(u.id, u.tenantId, body);
  }

  @Get('list')
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.id, u.tenantId);
  }

  @Delete('delete/:id')
  @HttpCode(204)
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.svc.remove(u.id, u.tenantId, id);
  }

  // Login flow is unauthenticated — caller supplies tenant + username,
  // and after a successful assertion gets a session JWT back.
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('login-start')
  @HttpCode(200)
  async loginStart(@Body() body: LoginStartDto) {
    const tenant = await this.tenants.findOne({ where: { slug: body.tenantSlug, isActive: true } });
    if (!tenant) throw new NotFoundException('tenant not found');
    return this.svc.loginStart(tenant.id, body.username);
  }

  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('login-finish')
  @HttpCode(200)
  async loginFinish(@Body() body: LoginFinishDto) {
    const tenant = await this.tenants.findOne({ where: { slug: body.tenantSlug, isActive: true } });
    if (!tenant) throw new NotFoundException('tenant not found');
    return this.svc.loginFinish(tenant.id, body.username, body.response);
  }
}
