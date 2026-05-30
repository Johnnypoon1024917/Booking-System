import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RolePermission } from './role-permission.entity';
import { catalog, defaultMatrix, PermissionGroup } from './permission-catalog';
import { Roles } from '../../common/decorators/roles.decorator';

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
export class PermissionsService {
  // Per-(tenant,role) permission cache for the hot enforcement path
  // (PermissionsGuard runs on every guarded request). Short TTL so an
  // admin's matrix edit takes effect quickly; setRole() also invalidates
  // the tenant's entries immediately.
  private readonly cache = new Map<string, { perms: Set<string>; expiresAt: number }>();
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    @InjectRepository(RolePermission) private readonly repo: Repository<RolePermission>,
  ) {}

  // hasPermission resolves whether a role holds a permission in the tenant's
  // matrix, consulting (and populating) the cache. A role with no stored row
  // falls back to the catalog defaults so a tenant that never opened the admin
  // matrix still behaves exactly as before this guard existed (no lock-out).
  async hasPermission(tenantId: string, role: string, permission: string): Promise<boolean> {
    const key = `${tenantId}::${role}`;
    const hit = this.cache.get(key);
    let perms: Set<string>;
    if (hit && hit.expiresAt > Date.now()) {
      perms = hit.perms;
    } else {
      const row = await this.repo.findOne({ where: { tenantId, role } });
      const list = row?.permissions ?? defaultMatrix()[role] ?? [];
      perms = new Set(list);
      this.cache.set(key, { perms, expiresAt: Date.now() + PermissionsService.CACHE_TTL_MS });
    }
    return perms.has(permission);
  }

  private invalidate(tenantId: string) {
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
}
