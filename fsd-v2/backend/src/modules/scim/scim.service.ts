import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { ScimToken } from './scim-token.entity';
import { User } from '../users/user.entity';
import { Department } from '../departments/department.entity';
import { AdminRoles, Role, Roles } from '../../common/decorators/roles.decorator';

// SCIM provisioning maps the IdP `title` attribute onto our role, but a
// provisioning token is NOT an interactive admin session and `title` is a
// free-form, IdP-controlled string. Allowing it to set any role lets a SCIM
// token (or an over-broad IdP attribute mapping) mint a System Admin and take
// over the tenant. So we clamp: SCIM may only assign non-admin roles; any
// admin-tier or unknown title falls back to General User. Privilege elevation
// to an admin role must go through the audited admin UI, never SCIM.
const KNOWN_ROLES: ReadonlyArray<string> = Object.values(Roles);
function resolveScimRole(title: unknown): Role {
  const t = typeof title === 'string' ? title.trim() : '';
  if (KNOWN_ROLES.includes(t) && !AdminRoles.includes(t as Role)) return t as Role;
  return Roles.GeneralUser;
}

// Implements the slice of SCIM 2.0 (RFC 7644) that Azure AD, Okta, and
// JumpCloud actually use for user provisioning. Auth is a bearer
// token from `scim_tokens`; we resolve the token to a tenant_id and
// scope every query to that tenant.
@Injectable()
export class ScimService {
  constructor(
    @InjectRepository(ScimToken) private readonly tokens: Repository<ScimToken>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Department) private readonly depts: Repository<Department>,
  ) {}

  // ----- token admin -----
  // Tokens are mandatorily time-boxed (NIST 800-53 IA-5). `expiresInDays`
  // is clamped to a sane window; callers pick from a fixed UI list but we
  // re-validate here since this is the security boundary.
  private static readonly MAX_EXPIRY_DAYS = 365;
  private static readonly DEFAULT_EXPIRY_DAYS = 90;

  async issue(tenantId: string, name: string, expiresInDays?: number) {
    const days = Math.min(
      Math.max(Math.floor(expiresInDays ?? ScimService.DEFAULT_EXPIRY_DAYS), 1),
      ScimService.MAX_EXPIRY_DAYS,
    );
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    const plain = `scim_${randomBytes(24).toString('hex')}`;
    const prefix = plain.slice(0, 12);
    const tokenHash = await bcrypt.hash(plain, 10);
    const t = await this.tokens.save(
      this.tokens.create({ tenantId, name: name || 'SCIM client', prefix, tokenHash, expiresAt }),
    );
    return { id: t.id, name: t.name, prefix: t.prefix, token: plain, expiresAt: t.expiresAt };
  }
  list(tenantId: string) {
    return this.tokens.find({
      where: { tenantId },
      select: ['id', 'name', 'prefix', 'createdAt', 'lastUsedAt', 'expiresAt', 'active'],
      order: { createdAt: 'DESC' },
    });
  }
  async revoke(tenantId: string, id: string) {
    const r = await this.tokens.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('token not found');
  }

  // ----- authentication -----
  async resolveBearer(bearer: string | undefined): Promise<string> {
    if (!bearer || !bearer.startsWith('Bearer ')) throw new UnauthorizedException();
    const plain = bearer.slice(7).trim();
    if (!plain.startsWith('scim_')) throw new UnauthorizedException();
    const prefix = plain.slice(0, 12);
    // Look up candidates by prefix to avoid bcrypt'ing every row.
    const candidates = await this.tokens.find({ where: { prefix, active: true } });
    for (const c of candidates) {
      if (await bcrypt.compare(plain, c.tokenHash)) {
        // Reject expired (or legacy null-expiry) tokens — a matched hash is
        // not enough once the token's lifetime has lapsed.
        if (!c.expiresAt || c.expiresAt.getTime() <= Date.now()) {
          throw new UnauthorizedException('token expired');
        }
        c.lastUsedAt = new Date();
        await this.tokens.save(c);
        return c.tenantId;
      }
    }
    throw new UnauthorizedException();
  }

  // ----- Users -----
  async listUsers(tenantId: string, startIndex: number, count: number, filter?: string) {
    let qb = this.users
      .createQueryBuilder('u')
      .where('u.tenant_id = :tid', { tid: tenantId })
      .orderBy('u.username', 'ASC');
    if (filter) {
      // Cheap parser for `userName eq "x"` — what Azure AD sends.
      const m = filter.match(/^(\w+)\s+eq\s+"([^"]+)"$/i);
      if (m && m[1].toLowerCase() === 'username') {
        qb = qb.andWhere('u.username = :v', { v: m[2] });
      }
    }
    const total = await qb.getCount();
    const rows = await qb.skip(Math.max(0, startIndex - 1)).take(count).getMany();
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((u) => this.toScimUser(u)),
    };
  }

  async getUser(tenantId: string, id: string) {
    const u = await this.users.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('user not found');
    return this.toScimUser(u);
  }

  async createUser(tenantId: string, body: any) {
    if (!body.userName) throw new UnauthorizedException('userName required');
    const u = this.users.create({
      tenantId,
      username: body.userName,
      passwordHash: '!scim!',
      role: resolveScimRole(body.title),
      isActive: body.active ?? true,
      regionAccess: [],
      dn: body.displayName || body.name?.formatted || body.userName,
    } as any);
    // Repository.save() is typed as TEntity | TEntity[] depending on
    // the input shape; we always pass a single entity, so narrow it.
    const saved = (await this.users.save(u)) as unknown as User;
    return this.toScimUser(saved);
  }

  async replaceUser(tenantId: string, id: string, body: any) {
    const u = await this.users.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('user not found');
    u.username = body.userName ?? u.username;
    if (body.active !== undefined) u.isActive = body.active;
    if (body.title) u.role = resolveScimRole(body.title);
    if (body.displayName) u.dn = body.displayName;
    return this.toScimUser(await this.users.save(u));
  }

  // PATCH ops as used by Azure AD: replace active, displayName, title.
  async patchUser(tenantId: string, id: string, body: any) {
    const u = await this.users.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('user not found');
    for (const op of body.Operations || []) {
      const path = String(op.path || '').toLowerCase();
      const val = op.value;
      const opName = String(op.op || '').toLowerCase();
      if (opName === 'replace' || opName === 'add') {
        if (path === 'active') u.isActive = Boolean(val);
        else if (path === 'displayname') u.dn = String(val);
        else if (path === 'title') u.role = resolveScimRole(val);
        else if (path === 'username') u.username = String(val);
      } else if (opName === 'remove' && path === 'active') {
        u.isActive = false;
      }
    }
    return this.toScimUser(await this.users.save(u));
  }

  async deleteUser(tenantId: string, id: string) {
    const u = await this.users.findOne({ where: { id, tenantId } });
    if (!u) throw new NotFoundException('user not found');
    // SCIM semantics: hard-delete returns 204; soft-deactivate is also
    // acceptable. We soft-deactivate so audit and history are preserved.
    u.isActive = false;
    await this.users.save(u);
  }

  // ----- Groups (map to Department) -----
  async listGroups(tenantId: string, startIndex: number, count: number) {
    const [rows, total] = await this.depts.findAndCount({
      where: { tenantId },
      skip: Math.max(0, startIndex - 1),
      take: count,
    });
    return {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: rows.length,
      Resources: rows.map((g) => this.toScimGroup(g)),
    };
  }
  async getGroup(tenantId: string, id: string) {
    const g = await this.depts.findOne({ where: { id, tenantId } });
    if (!g) throw new NotFoundException('group not found');
    return this.toScimGroup(g);
  }
  async createGroup(tenantId: string, body: any) {
    const g = this.depts.create({ tenantId, name: body.displayName } as any);
    return this.toScimGroup(await this.depts.save(g));
  }
  async replaceGroup(tenantId: string, id: string, body: any) {
    const g = await this.depts.findOne({ where: { id, tenantId } });
    if (!g) throw new NotFoundException('group not found');
    if (body.displayName) (g as any).name = body.displayName;
    return this.toScimGroup(await this.depts.save(g));
  }
  async deleteGroup(tenantId: string, id: string) {
    const r = await this.depts.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('group not found');
  }

  // ----- mapping -----
  private toScimUser(u: User) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: u.id,
      userName: u.username,
      displayName: u.dn || u.username,
      active: u.isActive,
      title: u.role,
      name: { formatted: u.dn || u.username },
      meta: {
        resourceType: 'User',
        location: `/scim/v2/Users/${u.id}`,
        created: u.createdAt,
        lastModified: u.updatedAt,
      },
    };
  }
  private toScimGroup(g: any) {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'],
      id: g.id,
      displayName: g.name,
      meta: { resourceType: 'Group', location: `/scim/v2/Groups/${g.id}` },
    };
  }
}
