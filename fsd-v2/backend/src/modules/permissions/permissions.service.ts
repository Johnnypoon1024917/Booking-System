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
  constructor(
    @InjectRepository(RolePermission) private readonly repo: Repository<RolePermission>,
  ) {}

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
    return { previous, next: clean };
  }
}
