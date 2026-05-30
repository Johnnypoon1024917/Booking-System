import {
  Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';
import { Request, Response } from 'express';
import { SsoService } from './sso.service';
import { Public } from '../../common/decorators/public.decorator';
import { RateLimit } from '../../common/guards/rate-limit.guard';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { RequireRoles, AdminRoles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { UseGuards } from '@nestjs/common';

class LdapLoginDto {
  @IsString() tenantSlug!: string;
  @IsString() provider!: string;
  @IsString() username!: string;
  @IsString() password!: string;
}
class ProviderDto {
  @IsString() slug!: string;
  @IsString() name!: string;
  @IsString() kind!: 'saml' | 'oauth2' | 'ldap';
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsObject() config!: Record<string, any>;
}

@ApiTags('sso')
@Controller('sso')
export class SsoController {
  constructor(private readonly svc: SsoService) {}

  // Public catalogue used by the login screen to populate the
  // "Sign in with..." picker.
  @Public()
  @Get('providers')
  list(@Query('tenant') tenantSlug: string) {
    return this.svc.listForTenant(tenantSlug || 'default');
  }

  // ----- SAML -----
  @Public()
  @Get('saml/init')
  async samlInit(
    @Query('tenant') tenantSlug: string,
    @Query('provider') provider: string,
    @Query('redirect') redirect: string,
    @Res() res: Response,
  ) {
    const { url } = await this.svc.samlInit(tenantSlug, provider, redirect);
    res.redirect(302, url);
  }

  // The IdP POSTs the SAMLResponse here. We finish the flow and
  // redirect back into the SPA with the token in the URL fragment so
  // it doesn't appear in access logs.
  @Public()
  @Post('saml/acs')
  @HttpCode(303)
  async samlAcs(@Req() req: Request, @Res() res: Response) {
    const body = req.body || {};
    const out = await this.svc.samlAcs(body.SAMLResponse, body.RelayState);
    const redirect = out.redirectAfter || '/';
    res.redirect(303, `${redirect}#token=${encodeURIComponent(out.accessToken!)}`);
  }

  // ----- OAuth2 -----
  @Public()
  @Get('oauth2/init')
  async oauth2Init(
    @Query('tenant') tenantSlug: string,
    @Query('provider') provider: string,
    @Query('redirect') redirect: string,
    @Res() res: Response,
  ) {
    const { url } = await this.svc.oauth2Init(tenantSlug, provider, redirect);
    res.redirect(302, url);
  }

  @Public()
  @Get('oauth2/callback')
  async oauth2Callback(
    @Query('state') state: string,
    @Query('code') code: string,
    @Res() res: Response,
  ) {
    const out = await this.svc.oauth2Callback(state, code);
    const redirect = out.redirectAfter || '/';
    res.redirect(303, `${redirect}#token=${encodeURIComponent(out.accessToken!)}`);
  }

  // ----- LDAP (direct credential POST from SPA login form) -----
  @Public()
  @RateLimit({ limit: 10, windowMs: 5 * 60_000 })
  @Post('ldap/login')
  @HttpCode(200)
  ldapLogin(@Body() body: LdapLoginDto) {
    return this.svc.ldapLogin(body.tenantSlug, body.provider, body.username, body.password);
  }

  // ----- admin CRUD -----
  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @Get('admin/providers')
  adminList(@CurrentUser() u: AuthUser) {
    return this.svc.listAll(u.tenantId);
  }

  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @Post('admin/providers')
  adminCreate(@CurrentUser() u: AuthUser, @Body() body: ProviderDto) {
    return this.svc.create(u.tenantId, body as any);
  }

  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @Put('admin/providers/:id')
  adminUpdate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: ProviderDto) {
    return this.svc.update(u.tenantId, id, body as any);
  }

  @ApiBearerAuth()
  @UseGuards(RolesGuard)
  @RequireRoles(...AdminRoles)
  @Delete('admin/providers/:id')
  @HttpCode(204)
  adminDelete(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.remove(u.tenantId, id);
  }
}
