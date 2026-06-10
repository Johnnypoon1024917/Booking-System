import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RolePermission } from './role-permission.entity';
import { User } from '../users/user.entity';
import { catalog, defaultMatrix, systemRoles, PermissionGroup } from './permission-catalog';
import { Roles } from '../../common/decorators/roles.decorator';
import { RedisService } from '../../common/redis/redis.service';

// Channel for cross-pod permission-cache invalidation. Payload is the tenantId
// whose entries must be dropped (or '*' to clear everything).
const PERMS_INVALIDATE_CHANNEL = 'perms:invalidate';

export interface RoleMatrix {
  tenantId: string;
  roles: Record<string, string[]>;
  // Per-role optimistic-concurrency token (the row's updatedAt, ISO). The
  // admin UI echoes it back on save so a stale edit can't silently clobber
  // a concurrent change.
  versions: Record<string, string>;
  catalog: PermissionGroup[];
}

@Injectable()
export class PermissionsService implements OnModuleInit {
  // Per-(tenant,role) permission cache for the hot enforcement path
  // (PermissionsGuard runs on every guarded request). Kept LOCAL on purpose —
  // a per-request Redis round-trip would be slower than this in-process Set
  // lookup. Short TTL so an admin's matrix edit takes effect quickly; a write
  // also invalidates the tenant's entries immediately.
  //
  // Multi-instance: invalidate() clears only the local pod. Behind a load
  // balancer that would leave other pods serving stale permission decisions for
  // up to the TTL after a matrix edit. So a write now also PUBLISHES the tenant
  // to PERMS_INVALIDATE_CHANNEL and every pod drops its matching entries the
  // instant it receives the message — local-cache speed with cross-pod
  // consistency. (TTL remains as a backstop if a message is ever missed.)
  private readonly cache = new Map<string, { perms: Set<string>; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(RolePermission) private readonly repo: Repository<RolePermission>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly redis: RedisService,
  ) {}

  onModuleInit() {
    // Drop local entries when ANY pod (including this one) reports a matrix edit.
    this.redis.subscribe(PERMS_INVALIDATE_CHANNEL, (tenantId) => this.dropLocal(tenantId));
  }

  // hasPermission resolves whether a role holds a permission in the tenant's
  // matrix, consulting (and populating) the cache. A role with no stored row
  // falls back to the catalog defaults so a tenant that never opened the admin
  // matrix still behaves exactly as before this guard existed (no lock-out).
  async hasPermission(tenantId: string, role: string, permission: string): Promise<boolean> {
    return (await this.permsForRole(tenantId, role)).has(permission);
  }

  // The full effective permission list for a role in a tenant. Backs the
  // SPA's /auth/me hydration so the client can hide/disable surfaces the user
  // can't act on (the backend guard remains the real enforcement). Same source
  // as the hot path, so the UI never disagrees with what the guard grants.
  async effectivePermissions(tenantId: string, role: string): Promise<string[]> {
    return [...(await this.permsForRole(tenantId, role))];
  }

  // Resolve (and cache) a role's effective permission set in the tenant, falling
  // back to the catalog defaults for a role with no stored row — the same source
  // the hot enforcement path reads, so an escalation check here can't disagree
  // with what the guard would actually grant.
  private async permsForRole(tenantId: string, role: string): Promise<Set<string>> {
    const key = `${tenantId}::${role}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.perms;
    const row = await this.repo.findOne({ where: { tenantId, role } });
    const list = row?.permissions ?? defaultMatrix()[role] ?? [];
    const perms = new Set(list);
    this.cache.set(key, { perms, expiresAt: Date.now() + PermissionsService.CACHE_TTL_MS });
    return perms;
  }

  // Clear this tenant's entries locally AND tell every other pod to do the same.
  // The local clear is immediate (this request's own follow-up reads are correct
  // without a pub/sub round-trip); the publish fans the invalidation out. When
  // Redis is disabled, publish() is a no-op and this is just the local clear.
  private invalidate(tenantId: string) {
    this.dropLocal(tenantId);
    void this.redis.publish(PERMS_INVALIDATE_CHANNEL, tenantId);
  }

  private dropLocal(tenantId: string) {
    if (tenantId === '*') { this.cache.clear(); return; }
    for (const k of this.cache.keys()) {
      if (k.startsWith(`${tenantId}::`)) this.cache.delete(k);
    }
  }

  // Returns the full matrix; if a tenant has no rows yet we seed the
  // defaults lazily so an admin sees a populated grid on first visit.
  async get(tenantId: string): Promise<RoleMatrix> {
    let rows = await this.repo.find({ where: { tenantId } });
    if (rows.length === 0) {
      const seeds = Object.entries(defaultMatrix()).map(([role, permissions]) =>
        this.repo.create({ tenantId, role, permissions }),
      );
      rows = await this.repo.save(seeds);
    }
    const roles: Record<string, string[]> = {};
    const versions: Record<string, string> = {};
    for (const r of rows) {
      roles[r.role] = r.permissions ?? [];
      versions[r.role] = r.updatedAt?.toISOString() ?? '';
    }
    return { tenantId, roles, versions, catalog: catalog() };
  }

  // Trim / dedupe before write — keeps the column clean and avoids the
  // matrix growing with stray whitespace entries.
  async setRole(
    tenantId: string,
    role: string,
    permissions: string[],
    expectedVersion?: string,
    actor?: { role: string },
  ): Promise<{ previous: string[]; next: string[]; version: string }> {
    // The root superuser role is immutable: PermissionsGuard hard-bypasses
    // System Admin regardless of the matrix, so editing its row is both
    // meaningless and a footgun (an admin who unticks boxes here believes
    // they changed something). Reject the write outright.
    if (role === Roles.SystemAdmin) {
      throw new ForbiddenException('The System Admin role is immutable and cannot be edited.');
    }

    const seen = new Set<string>();
    const clean: string[] = [];
    for (const p of permissions ?? []) {
      const t = (p ?? '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t); clean.push(t);
    }
    const existing = await this.repo.findOne({ where: { tenantId, role } });
    // Optimistic concurrency: if the caller loaded the matrix and someone
    // else saved this role in the meantime, the versions diverge — refuse
    // the write so the last writer can't blindly overwrite the first.
    if (expectedVersion !== undefined && existing) {
      const current = existing.updatedAt?.toISOString() ?? '';
      if (current !== expectedVersion) {
        throw new ConflictException(
          `The "${role}" permissions were changed by someone else. Reload and re-apply your edits.`,
        );
      }
    }
    const previous = existing?.permissions ?? [];

    // Anti-escalation: a non-root editor may only GRANT permission keys they
    // already hold themselves. Without this an admin with `permission.manage`
    // could tick `tenant.manage` / `customization.manage` on their own (or any)
    // role and instantly self-elevate to root. Removing keys is always allowed;
    // we only gate the keys being newly added. System Admin is hard-bypassed by
    // PermissionsGuard and holds everything, so it is exempt.
    if (actor && actor.role !== Roles.SystemAdmin) {
      const actorPerms = await this.permsForRole(tenantId, actor.role);
      const escalated = clean.filter((p) => !previous.includes(p) && !actorPerms.has(p));
      if (escalated.length) {
        throw new ForbiddenException(
          `You cannot grant permission(s) you do not hold yourself: ${escalated.join(', ')}.`,
        );
      }
    }

    let saved: RolePermission;
    if (existing) {
      existing.permissions = clean;
      saved = await this.repo.save(existing);
    } else {
      saved = await this.repo.save(this.repo.create({ tenantId, role, permissions: clean }));
    }
    this.invalidate(tenantId);
    return { previous, next: clean, version: saved.updatedAt?.toISOString() ?? '' };
  }

  // Create a tenant-defined custom role (e.g. "Catering Staff"). It starts with
  // no permissions; the admin then ticks boxes in the matrix and saves. Names
  // are unique per tenant (case-insensitive) and can't collide with a built-in
  // role, so the matrix never shows two rows that mean the same thing.
  async createRole(
    tenantId: string, role: string,
  ): Promise<{ role: string; version: string }> {
    const name = (role ?? '').trim();
    if (!name) throw new BadRequestException('a role name is required');
    if (name.length > 64) throw new BadRequestException('role name must be 64 characters or fewer');
    if (systemRoles().some((r) => r.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException(`"${name}" is a built-in role name`);
    }
    // get() lazily seeds the built-in rows, so an existing-row check also covers
    // a re-used built-in name even before the matrix was ever opened.
    const existing = await this.repo.findOne({ where: { tenantId, role: name } });
    if (existing) throw new ConflictException(`a role named "${name}" already exists`);
    const saved = await this.repo.save(this.repo.create({ tenantId, role: name, permissions: [] }));
    this.invalidate(tenantId);
    return { role: saved.role, version: saved.updatedAt?.toISOString() ?? '' };
  }

  // Delete a custom role. Built-in roles are protected. A role still assigned to
  // users is blocked (with a count) so we never strand accounts on a role that
  // no longer exists in the matrix — reassign those users first.
  async deleteRole(tenantId: string, role: string): Promise<void> {
    if (systemRoles().includes(role)) {
      throw new ForbiddenException('built-in roles cannot be deleted');
    }
    const inUse = await this.users.count({ where: { tenantId, role } });
    if (inUse > 0) {
      throw new ConflictException(
        `${inUse} user(s) still have the "${role}" role — reassign them before deleting it`,
      );
    }
    const res = await this.repo.delete({ tenantId, role });
    if (!res.affected) throw new NotFoundException('role not found');
    this.invalidate(tenantId);
  }
}
