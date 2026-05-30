import { BadRequestException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { WebauthnChallenge, WebauthnCredential } from './webauthn-credential.entity';
import { User } from '../users/user.entity';
import { AuthService } from '../auth/auth.service';

// WebAuthn (passkey) flows backed by @simplewebauthn/server. The RP
// identity is configured via env so dev (localhost) and prod can both
// run without code changes. The challenge table holds one row per
// in-flight ceremony and is wiped on use or by the periodic sweep.
@Injectable()
export class WebauthnService {
  private readonly rpID = process.env.WEBAUTHN_RP_ID || 'localhost';
  private readonly rpName = process.env.WEBAUTHN_RP_NAME || 'FSD MRBS';
  private readonly origin =
    process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';

  constructor(
    @InjectRepository(WebauthnCredential)
    private readonly creds: Repository<WebauthnCredential>,
    @InjectRepository(WebauthnChallenge)
    private readonly challenges: Repository<WebauthnChallenge>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly auth: AuthService,
  ) {}

  async list(userId: string, tenantId: string) {
    return this.creds.find({
      where: { userId, tenantId },
      order: { createdAt: 'DESC' },
      select: ['id', 'nickname', 'aaguid', 'createdAt', 'lastUsedAt'],
    });
  }

  async remove(userId: string, tenantId: string, id: string) {
    const r = await this.creds.delete({ id, userId, tenantId });
    if (!r.affected) throw new NotFoundException('credential not found');
  }

  // -------- registration --------

  async registerStart(userId: string, tenantId: string) {
    const user = await this.users.findOne({ where: { id: userId, tenantId } });
    if (!user) throw new UnauthorizedException('user not found');
    const excluded = await this.creds.find({ where: { userId, tenantId } });
    // @simplewebauthn/server v9: userID is a plain string; v10 switched
    // to Uint8Array. We pin v9 in package.json so string is correct.
    // The `as any` on credential descriptors silences a structural
    // mismatch on `transports` whose enum lives in @simplewebauthn/types
    // but the entity stores it as a free-string column.
    const opts = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: user.id,
      userName: user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      authenticatorSelection: {
        userVerification: 'preferred',
        residentKey: 'preferred',
      },
      excludeCredentials: excluded.map((c) => ({
        id: c.credentialId,
        transports: (c.transports as any) || undefined,
      })) as any,
    });
    await this.persistChallenge(userId, tenantId, opts.challenge, 'register');
    return opts;
  }

  async registerFinish(
    userId: string,
    tenantId: string,
    body: { nickname?: string; response: any },
  ) {
    const challenge = await this.takeChallenge(userId, tenantId, 'register');
    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      throw new UnauthorizedException('registration failed verification');
    }
    const info: any = verification.registrationInfo;
    // simplewebauthn v9: credentialID is Uint8Array; v10+: { credential: { id, publicKey, counter } }
    const credentialId: string = info.credential?.id
      ? info.credential.id
      : Buffer.from(info.credentialID).toString('base64url');
    const publicKeyBytes: Uint8Array = info.credential?.publicKey ?? info.credentialPublicKey;
    const counter: number = info.credential?.counter ?? info.counter ?? 0;
    const aaguid: string | undefined = info.aaguid;

    await this.creds.save(
      this.creds.create({
        tenantId,
        userId,
        credentialId,
        publicKey: Buffer.from(publicKeyBytes).toString('base64url'),
        counter,
        aaguid,
        nickname: body.nickname || 'Passkey',
        transports: body.response?.response?.transports || [],
      }),
    );
    return { ok: true };
  }

  // -------- authentication --------

  async loginStart(tenantId: string, username: string) {
    const user = await this.users.findOne({ where: { tenantId, username } });
    if (!user) throw new UnauthorizedException('invalid credentials');
    const creds = await this.creds.find({ where: { userId: user.id, tenantId } });
    if (!creds.length) throw new UnauthorizedException('no passkey enrolled');
    const opts = await generateAuthenticationOptions({
      rpID: this.rpID,
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({
        id: c.credentialId,
        transports: (c.transports as any) || undefined,
      })) as any,
    });
    await this.persistChallenge(user.id, tenantId, opts.challenge, 'login');
    return opts;
  }

  async loginFinish(tenantId: string, username: string, response: any) {
    const user = await this.users.findOne({ where: { tenantId, username } });
    if (!user) throw new UnauthorizedException('invalid credentials');
    const credentialId: string = response.id;
    const stored = await this.creds.findOne({
      where: { tenantId, credentialId },
    });
    if (!stored || stored.userId !== user.id) {
      throw new UnauthorizedException('unknown credential');
    }
    const challenge = await this.takeChallenge(user.id, tenantId, 'login');

    const authenticator: any = {
      // v9 shape
      credentialID: Buffer.from(stored.credentialId, 'base64url'),
      credentialPublicKey: Buffer.from(stored.publicKey, 'base64url'),
      counter: Number(stored.counter),
      transports: stored.transports,
    };
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      // both keys provided so v9 and v10+ are happy
      authenticator,
      credential: {
        id: stored.credentialId,
        publicKey: Buffer.from(stored.publicKey, 'base64url'),
        counter: Number(stored.counter),
        transports: stored.transports as any,
      },
    } as any);
    if (!verification.verified) throw new UnauthorizedException('assertion failed');

    const info: any = verification.authenticationInfo;
    stored.counter = info?.newCounter ?? Number(stored.counter) + 1;
    stored.lastUsedAt = new Date();
    await this.creds.save(stored);

    // Passkey login implies user verification → mfa: true claim.
    return this.auth.issueForFederated(user, tenantId);
  }

  // -------- helpers --------

  private async persistChallenge(
    userId: string,
    tenantId: string,
    challenge: string,
    purpose: string,
  ) {
    // Clear any stale challenge for this purpose first.
    await this.challenges.delete({ userId, tenantId, purpose });
    // Sweep old challenges older than 10 minutes.
    await this.challenges.delete({
      createdAt: LessThan(new Date(Date.now() - 10 * 60_000)),
    });
    await this.challenges.save(
      this.challenges.create({ userId, tenantId, challenge, purpose }),
    );
  }

  private async takeChallenge(
    userId: string,
    tenantId: string,
    purpose: string,
  ): Promise<string> {
    const c = await this.challenges.findOne({
      where: { userId, tenantId, purpose },
      order: { createdAt: 'DESC' },
    });
    if (!c) throw new BadRequestException('no pending challenge');
    if (Date.now() - c.createdAt.getTime() > 10 * 60_000) {
      await this.challenges.delete({ id: c.id });
      throw new BadRequestException('challenge expired');
    }
    await this.challenges.delete({ id: c.id });
    return c.challenge;
  }
}
