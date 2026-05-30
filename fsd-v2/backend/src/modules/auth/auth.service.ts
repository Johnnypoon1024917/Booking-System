import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UsersService } from '../users/users.service';
import { Tenant } from '../tenants/tenant.entity';
import { User } from '../users/user.entity';

// Result returned from the password-step. The SPA branches on
// `requiresMfa`: if true, it collects the TOTP code and POSTs to
// /auth/mfa/login-verify with the `mfaToken`. The mfaToken is a
// short-lived JWT scoped purely for the second step (purpose=mfa).
export interface LoginResult {
  accessToken?: string;
  user?: any;
  requiresMfa?: boolean;
  mfaToken?: string;
  // Set when the account was issued an initial password the user must
  // replace before a session is granted. The SPA collects a new password
  // and POSTs it to /auth/change-password with this short-lived token.
  mustChangePassword?: boolean;
  changeToken?: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
  ) {}

  // Resolves the tenant from the request body (slug), then the user
  // inside that tenant by username, then bcrypt-compares the password.
  // All three checks use the SAME failure path so a probe can't
  // enumerate which step failed.
  async login(tenantSlug: string, username: string, password: string): Promise<LoginResult> {
    const tenant = await this.tenants.findOne({ where: { slug: tenantSlug, isActive: true } });
    if (!tenant) throw new UnauthorizedException('invalid credentials');

    const user = await this.users.findByUsername(tenant.id, username);
    if (!user || !user.isActive) throw new UnauthorizedException('invalid credentials');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');

    // Force-change gate: an admin-issued initial password must be replaced
    // before any session (or MFA step). Mint a short-lived token scoped to
    // the change-password exchange only.
    if (user.mustChangePassword) {
      const changeToken = this.jwt.sign(
        { sub: user.id, tid: tenant.id, username: user.username, purpose: 'pwd_change' },
        { expiresIn: '10m' },
      );
      return { mustChangePassword: true, changeToken };
    }

    // MFA gate: if enrolled, mint a short-lived intermediate token and
    // let the SPA hit /auth/mfa/login-verify with the TOTP code.
    if (user.mfaEnabled) {
      const mfaToken = this.jwt.sign(
        { sub: user.id, tid: tenant.id, username: user.username, purpose: 'mfa' },
        { expiresIn: '5m' },
      );
      return { requiresMfa: true, mfaToken };
    }

    return { accessToken: this.issueAccessToken(user, tenant.id, tenant.slug, false), user: this.profile(user, tenant) };
  }

  // Issue a normal session token after a successful password (and
  // optional MFA) check. `mfaVerified=true` adds a `mfa: true` claim
  // so downstream guards can require step-up.
  issueAccessToken(user: User, tenantId: string, _slug: string, mfaVerified: boolean) {
    const ttl = process.env.JWT_TTL || '12h';
    return this.jwt.sign(
      {
        sub: user.id,
        tid: tenantId,
        username: user.username,
        role: user.role,
        grade: user.grade,
        regions: user.regionAccess,
        ...(mfaVerified ? { mfa: true } : {}),
      },
      { expiresIn: ttl },
    );
  }

  profile(user: User, tenant: Tenant) {
    return {
      id: user.id,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      username: user.username,
      role: user.role,
      grade: user.grade,
      regionAccess: user.regionAccess,
      mfaEnabled: user.mfaEnabled,
    };
  }

  // Complete a forced password reset: validate the scoped change-token,
  // set the new password (which clears mustChangePassword), then issue a
  // full session so the user lands logged in.
  async changePassword(changeToken: string, newPassword: string): Promise<LoginResult> {
    let claims: any;
    try { claims = this.jwt.verify(changeToken); }
    catch { throw new UnauthorizedException('reset link expired — sign in again'); }
    if (claims?.purpose !== 'pwd_change') throw new UnauthorizedException('invalid reset token');
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('password must be at least 8 characters');
    }
    const tenant = await this.tenants.findOne({ where: { id: claims.tid, isActive: true } });
    if (!tenant) throw new UnauthorizedException('invalid reset token');
    const user = await this.users.setPassword(claims.tid, claims.sub, newPassword);
    return { accessToken: this.issueAccessToken(user, tenant.id, tenant.slug, false), user: this.profile(user, tenant) };
  }

  async resolveTenant(id: string) {
    return this.tenants.findOne({ where: { id, isActive: true } });
  }

  // Used by SSO providers (saml/oauth2/ldap) once they've authenticated
  // a federated principal — issue the JWT directly.
  async issueForFederated(user: User, tenantId: string) {
    const tenant = await this.tenants.findOne({ where: { id: tenantId } });
    if (!tenant) throw new UnauthorizedException('tenant missing');
    return {
      accessToken: this.issueAccessToken(user, tenantId, tenant.slug, false),
      user: this.profile(user, tenant),
    };
  }
}
