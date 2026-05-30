import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import { User } from '../users/user.entity';
import { AuthService } from '../auth/auth.service';

// TOTP MFA. Mirrors v1's domain/mfa/totp.go semantics:
//   enroll  → store a *pending* secret (mfa_enabled stays false)
//   verify  → check first code, flip mfa_enabled
//   disable → wipe the secret after one final code
//
// The login-step-up path lives in `verifyLogin`, which exchanges the
// short-lived `mfaToken` issued by AuthService.login() for a full
// session token with the `mfa: true` claim.
@Injectable()
export class MfaService {
  private readonly issuer = process.env.MFA_ISSUER || 'FSD MRBS';

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
  ) {}

  async enroll(userId: string, tenantId: string) {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.mfaSecret')
      .where('u.id = :id AND u.tenant_id = :tid', { id: userId, tid: tenantId })
      .getOne();
    if (!user) throw new UnauthorizedException('user not found');

    const secret = speakeasy.generateSecret({
      length: 20,
      name: `${this.issuer}:${user.username}`,
      issuer: this.issuer,
    });
    // Persist as pending — only verify() flips mfaEnabled.
    await this.users.update(
      { id: userId, tenantId },
      { mfaSecret: secret.base32, mfaEnabled: false },
    );
    const otpauth = secret.otpauth_url!;
    const qrDataUrl = await QRCode.toDataURL(otpauth);
    return { secret: secret.base32, otpauthUrl: otpauth, qrDataUrl };
  }

  async verify(userId: string, tenantId: string, code: string) {
    if (!code) throw new BadRequestException('code required');
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.mfaSecret')
      .where('u.id = :id AND u.tenant_id = :tid', { id: userId, tid: tenantId })
      .getOne();
    if (!user || !user.mfaSecret) {
      throw new BadRequestException('no pending enrolment; call /enroll first');
    }
    const ok = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
    if (!ok) throw new UnauthorizedException('invalid code');
    await this.users.update(
      { id: userId, tenantId },
      { mfaEnabled: true, mfaEnrolledAt: new Date() },
    );
    return { enabled: true };
  }

  async disable(userId: string, tenantId: string, code: string) {
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.mfaSecret')
      .where('u.id = :id AND u.tenant_id = :tid', { id: userId, tid: tenantId })
      .getOne();
    if (!user || !user.mfaSecret) throw new BadRequestException('mfa not enrolled');
    const ok = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
    if (!ok) throw new UnauthorizedException('invalid code');
    await this.users.update(
      { id: userId, tenantId },
      { mfaEnabled: false, mfaSecret: null as any, mfaEnrolledAt: null as any },
    );
    return { enabled: false };
  }

  async status(userId: string, tenantId: string) {
    const u = await this.users.findOne({ where: { id: userId, tenantId } });
    return { enabled: !!u?.mfaEnabled, enrolledAt: u?.mfaEnrolledAt ?? null };
  }

  // Step-up: the SPA exchanges the short-lived mfaToken (purpose='mfa')
  // plus the TOTP code for a full session JWT.
  async verifyLogin(mfaToken: string, code: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(mfaToken);
    } catch {
      throw new UnauthorizedException('invalid or expired mfa token');
    }
    if (payload.purpose !== 'mfa') throw new UnauthorizedException('not an mfa token');
    const user = await this.users
      .createQueryBuilder('u')
      .addSelect('u.mfaSecret')
      .where('u.id = :id AND u.tenant_id = :tid', { id: payload.sub, tid: payload.tid })
      .getOne();
    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new UnauthorizedException('mfa not configured');
    }
    const ok = speakeasy.totp.verify({
      secret: user.mfaSecret,
      encoding: 'base32',
      token: code,
      window: 1,
    });
    if (!ok) throw new UnauthorizedException('invalid code');
    const tenant = await this.auth.resolveTenant(payload.tid);
    if (!tenant) throw new UnauthorizedException('tenant missing');
    return {
      accessToken: this.auth.issueAccessToken(user, tenant.id, tenant.slug, true),
      user: this.auth.profile(user, tenant),
    };
  }
}
