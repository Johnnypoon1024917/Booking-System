import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RolePermission } from './role-permission.entity';
import { catalog, defaultMatrix, PermissionGroup } from './permission-catalog';

export interface RoleMatrix {
  tenantId: string;
  roles: Record<string, string[]>;
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
    for (const r of rows) roles[r.role] = r.permissions ?? [];
    return { tenantId, roles, catalog: catalog() };
  }

  // Trim / dedupe before write — keeps the column clean and avoids the
  // matrix growing with stray whitespace entries.
  async setRole(tenantId: string, role: string, permissions: string[]): Promise<{ previous: string[]; next: string[] }> {
    const seen = new Set<string>();
    const clean: string[] = [];
    for (const p of permissions ?? []) {
      const t = (p ?? '').trim();
      if (!t || seen.has(t)) continue;
      seen.add(t); clean.push(t);
    }
    const existing = await this.repo.findOne({ where: { tenantId, role } });
    const previous = existing?.permissions ?? [];
    if (existing) {
      existing.permissions = clean;
      await this.repo.save(existing);
    } else {
      await this.repo.save(this.repo.create({ tenantId, role, permissions: clean }));
    }
    this.invalidate(tenantId);
    return { previous, next: clean };
  }
}
