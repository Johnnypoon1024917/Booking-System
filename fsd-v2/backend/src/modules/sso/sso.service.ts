import {
  BadRequestException, Injectable, NotFoundException, UnauthorizedException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { randomBytes, createHash } from 'crypto';
import { AuthorizationCode } from 'simple-oauth2';
// passport-saml exports SAML for response validation; we use it directly
// rather than wiring a full passport pipeline because the flow here is
// purely controller-driven.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SAML } = require('passport-saml');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ldap = require('ldapjs');
import { IdentityProvider, ProviderKind, SsoState } from './identity-provider.entity';
import { User } from '../users/user.entity';
import { Tenant } from '../tenants/tenant.entity';
import { AuthService } from '../auth/auth.service';
import { v5 as uuidv5 } from 'uuid';

const SSO_NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // RFC 4122 DNS namespace

// Service implementing the v1 provider_factory dispatch in TS. Each
// `kind` has its own start/finish pair; `upsertFederated` reconciles
// the local user row and AuthService issues the session JWT.
@Injectable()
export class SsoService {
  constructor(
    @InjectRepository(IdentityProvider) private readonly providers: Repository<IdentityProvider>,
    @InjectRepository(SsoState) private readonly states: Repository<SsoState>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Tenant) private readonly tenants: Repository<Tenant>,
    private readonly auth: AuthService,
  ) {}

  // ---- public discovery ----
  async listForTenant(tenantSlug: string) {
    const t = await this.tenants.findOne({ where: { slug: tenantSlug, isActive: true } });
    if (!t) return [];
    const list = await this.providers.find({ where: { tenantId: t.id, enabled: true } });
    return list.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind }));
  }

  // ---- SAML ----
  async samlInit(tenantSlug: string, providerSlug: string, redirect?: string) {
    const { tenant, provider } = await this.resolve(tenantSlug, providerSlug, 'saml');
    const saml = this.samlClient(provider, tenant.id);
    const relay = randomBytes(16).toString('hex');
    const url: string = await new Promise((resolve, reject) =>
      saml.getAuthorizeUrl(
        { RelayState: relay } as any,
        {},
        (err: any, u: string) => (err ? reject(err) : resolve(u)),
      ),
    );
    await this.persistState({
      state: relay, tenantId: tenant.id, providerId: provider.id, kind: 'saml',
      redirectAfter: this.safeRedirect(redirect),
    });
    return { url };
  }

  async samlAcs(samlResponseB64: string, relayState?: string) {
    if (!samlResponseB64) throw new BadRequestException('missing SAMLResponse');
    let state: SsoState | null = null;
    if (relayState) {
      state = await this.states.findOne({ where: { state: relayState } });
    }
    if (!state) throw new UnauthorizedException('unknown relay state');
    if (Date.now() - state.createdAt.getTime() > 10 * 60_000) {
      await this.states.delete({ id: state.id });
      throw new UnauthorizedException('state expired');
    }
    const provider = await this.providers.findOne({ where: { id: state.providerId } });
    if (!provider) throw new NotFoundException('provider missing');
    const saml = this.samlClient(provider, state.tenantId);
    const result: any = await new Promise((resolve, reject) =>
      saml.validatePostResponse(
        { SAMLResponse: samlResponseB64 },
        (err: any, profile: any) => (err ? reject(err) : resolve(profile)),
      ),
    );
    await this.states.delete({ id: state.id });
    const email = result.email || result.nameID;
    const subject = result.nameID || email;
    const display = `${result.firstName || ''} ${result.lastName || ''}`.trim();
    const user = await this.upsertFederated(state.tenantId, 'saml', subject, email, display);
    return {
      ...(await this.auth.issueForFederated(user, state.tenantId)),
      redirectAfter: state.redirectAfter || '/',
    };
  }

  // ---- OAuth2 / OIDC ----
  async oauth2Init(tenantSlug: string, providerSlug: string, redirect?: string) {
    const { tenant, provider } = await this.resolve(tenantSlug, providerSlug, 'oauth2');
    const client = this.oauth2Client(provider);
    const state = randomBytes(16).toString('hex');
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = client.authorizeURL({
      redirect_uri: provider.config.callbackUrl,
      scope: provider.config.scope || 'openid profile email',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    } as any);
    await this.persistState({
      state, tenantId: tenant.id, providerId: provider.id, kind: 'oauth2',
      verifier, redirectAfter: this.safeRedirect(redirect),
    });
    return { url };
  }

  async oauth2Callback(stateToken: string, code: string) {
    if (!stateToken || !code) throw new BadRequestException('missing state or code');
    const state = await this.states.findOne({ where: { state: stateToken } });
    if (!state) throw new UnauthorizedException('unknown state');
    if (Date.now() - state.createdAt.getTime() > 10 * 60_000) {
      await this.states.delete({ id: state.id });
      throw new UnauthorizedException('state expired');
    }
    const provider = await this.providers.findOne({ where: { id: state.providerId } });
    if (!provider) throw new NotFoundException('provider missing');
    const client = this.oauth2Client(provider);
    const token = await client.getToken({
      code,
      redirect_uri: provider.config.callbackUrl,
      code_verifier: state.verifier,
    } as any);
    await this.states.delete({ id: state.id });

    // Pull profile from userinfo endpoint (works for any OIDC IdP).
    const accessToken = (token.token as any).access_token;
    const profile = await this.fetchUserinfo(provider.config.userInfoUrl, accessToken);
    const subject = profile.sub || profile.id || profile.email;
    const email = profile.email || subject;
    const display = profile.name || profile.preferred_username || email;
    if (!subject) throw new UnauthorizedException('userinfo missing subject');

    const user = await this.upsertFederated(state.tenantId, 'oauth2', subject, email, display);
    return {
      ...(await this.auth.issueForFederated(user, state.tenantId)),
      redirectAfter: state.redirectAfter || '/',
    };
  }

  // ---- LDAP ----
  async ldapLogin(tenantSlug: string, providerSlug: string, username: string, password: string) {
    const { tenant, provider } = await this.resolve(tenantSlug, providerSlug, 'ldap');
    const cfg = provider.config;
    const client = ldap.createClient({ url: cfg.url, timeout: 5000, connectTimeout: 5000 });
    try {
      // Two-step bind: service account binds, search for user DN, then
      // re-bind as the user with the supplied password.
      await new Promise<void>((resolve, reject) =>
        client.bind(cfg.bindDN, cfg.bindPassword, (err: any) => (err ? reject(err) : resolve())),
      );
      const filter = (cfg.searchFilter || '(uid={username})').replace('{username}', username);
      const entry: any = await new Promise((resolve, reject) => {
        const result: any[] = [];
        client.search(cfg.searchBase, { filter, scope: 'sub' }, (err: any, res: any) => {
          if (err) return reject(err);
          res.on('searchEntry', (e: any) => result.push(e.pojo || e.object));
          res.on('error', reject);
          res.on('end', () => resolve(result[0]));
        });
      });
      if (!entry) throw new UnauthorizedException('user not found in directory');
      const userDN = entry.objectName || entry.dn;
      await new Promise<void>((resolve, reject) =>
        client.bind(userDN, password, (err: any) => (err ? reject(err) : resolve())),
      );
      const attrs = this.flattenLdapAttrs(entry);
      const email = attrs.mail || attrs.userPrincipalName || username;
      const display = attrs.displayName || attrs.cn || username;
      const user = await this.upsertFederated(tenant.id, 'ldap', userDN, email, display);
      return this.auth.issueForFederated(user, tenant.id);
    } catch (e: any) {
      throw new UnauthorizedException('invalid credentials');
    } finally {
      try { client.unbind(); } catch {}
    }
  }

  // ---- admin CRUD ----
  async listAll(tenantId: string) {
    return this.providers.find({ where: { tenantId }, order: { name: 'ASC' } });
  }
  async create(tenantId: string, dto: Partial<IdentityProvider>) {
    return this.providers.save(this.providers.create({ ...dto, tenantId }));
  }
  async update(tenantId: string, id: string, dto: Partial<IdentityProvider>) {
    const existing = await this.providers.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('provider not found');
    Object.assign(existing, dto, { id, tenantId });
    return this.providers.save(existing);
  }
  async remove(tenantId: string, id: string) {
    await this.providers.delete({ id, tenantId });
  }

  // ---- helpers ----
  private samlClient(provider: IdentityProvider, _tenantId: string) {
    const cfg = provider.config;
    return new SAML({
      entryPoint: cfg.entryPoint,
      issuer: cfg.issuer,
      cert: cfg.cert,
      callbackUrl: cfg.callbackUrl,
      identifierFormat: cfg.identifierFormat || null,
      signatureAlgorithm: 'sha256',
    });
  }

  private oauth2Client(provider: IdentityProvider) {
    const cfg = provider.config;
    const tokenHost = new URL(cfg.tokenUrl);
    const authHost = new URL(cfg.authorizeUrl);
    return new AuthorizationCode({
      client: { id: cfg.clientId, secret: cfg.clientSecret },
      auth: {
        tokenHost: `${tokenHost.protocol}//${tokenHost.host}`,
        tokenPath: tokenHost.pathname,
        authorizeHost: `${authHost.protocol}//${authHost.host}`,
        authorizePath: authHost.pathname,
      },
    });
  }

  private async fetchUserinfo(url: string, accessToken: string) {
    // Use global fetch (Node 18+) so we don't pull another dependency.
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) throw new UnauthorizedException(`userinfo failed: ${r.status}`);
    return r.json();
  }

  private flattenLdapAttrs(entry: any): Record<string, string> {
    const out: Record<string, string> = {};
    const attrs = entry.attributes || [];
    for (const a of attrs) {
      const val = Array.isArray(a.values) ? a.values[0] : a.vals?.[0];
      if (val != null) out[a.type] = String(val);
    }
    return out;
  }

  private async upsertFederated(
    tenantId: string,
    kind: ProviderKind,
    subject: string,
    email: string,
    displayName: string,
  ): Promise<User> {
    // Deterministic UUIDv5 over (tenant, subject) — same scheme as v1
    // SSOHandler.upsertFederatedUser so the same external identity
    // resolves to the same local row across restarts.
    const stableId = uuidv5(`fsd-mrbs/${tenantId}/${subject}`, SSO_NS);
    const username = email || subject;
    const existing = await this.users.findOne({ where: { tenantId, username } });
    if (existing) {
      existing.ssoProvider = kind;
      existing.ssoSubject = subject;
      existing.isActive = true;
      return (await this.users.save(existing)) as unknown as User;
    }
    return (await this.users.save(
      this.users.create({
        id: stableId,
        tenantId,
        username,
        // Federated users have no local password — store an unusable
        // bcrypt placeholder so the column NOT NULL constraint holds.
        passwordHash: '!sso!',
        role: 'General User',
        dn: displayName,
        isActive: true,
        regionAccess: [],
        ssoProvider: kind,
        ssoSubject: subject,
      } as any),
    )) as unknown as User;
  }

  private async resolve(tenantSlug: string, providerSlug: string, expectedKind: ProviderKind) {
    const tenant = await this.tenants.findOne({ where: { slug: tenantSlug, isActive: true } });
    if (!tenant) throw new NotFoundException('tenant not found');
    const provider = await this.providers.findOne({
      where: { tenantId: tenant.id, slug: providerSlug, enabled: true },
    });
    if (!provider) throw new NotFoundException('provider not found');
    if (provider.kind !== expectedKind) {
      throw new BadRequestException(`provider is ${provider.kind}, expected ${expectedKind}`);
    }
    return { tenant, provider };
  }

  private safeRedirect(s?: string): string | undefined {
    if (!s) return undefined;
    return s.startsWith('/') && !s.startsWith('//') ? s : undefined;
  }

  private async persistState(p: Partial<SsoState>) {
    // GC anything older than 10 minutes on every insert.
    await this.states.delete({ createdAt: LessThan(new Date(Date.now() - 10 * 60_000)) });
    await this.states.save(this.states.create(p));
  }
}
