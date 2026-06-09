import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';
import { Department } from '../departments/department.entity';
import { normalizeLocale } from '../notifications/notifications.i18n';

export interface UpsertUserDto {
  username: string;
  email?: string;
  role: string;
  password?: string;
  mustChangePassword?: boolean;
  dn?: string;
  grade?: string;
  isActive?: boolean;
  managerId?: string;
  regionAccess?: string[];
  departmentIds?: string[];
  // Preferred language for system emails/push. Coerced to a supported
  // locale on write; defaults to 'en'.
  locale?: string;
}

// Normalise an optional FK id from a form: '' / whitespace → null (clear),
// otherwise the trimmed id. Keeps empty-string from being written as a
// non-null value that violates the uuid column.
//
// MUST tolerate an explicit `null`: the SPA round-trips the whole user object
// on edit, so a user with no line manager sends `managerId: null`. @IsOptional()
// lets that null through to the service, and the old `null.trim()` threw a
// TypeError that surfaced as a blanket 500 "Internal server error" on every
// edit of a manager-less user (QA #10).
function fkOrNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;       // field absent → leave unchanged
  if (v === null) return null;                 // explicit clear
  const t = v.trim();
  return t === '' ? null : t;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Department) private readonly depts: Repository<Department>,
  ) {}

  list(tenantId: string) {
    return this.users.find({
      where: { tenantId },
      relations: { departments: true },
      order: { username: 'ASC' },
    });
  }

  // Server-side paginated + searchable directory for AdminUsers. A
  // government tenant can hold tens of thousands of users; the old
  // unbounded list froze the browser, so the table now pulls one page at
  // a time. `search` matches username/email (case-insensitive substring).
  // We attach each row's manager username so the edit form's manager
  // typeahead can show the current selection without pulling the whole
  // directory.
  async listPaged(
    tenantId: string,
    opts: { page: number; pageSize: number; search: string },
  ) {
    const { page, pageSize, search } = opts;
    const qb = this.users.createQueryBuilder('u')
      .leftJoinAndSelect('u.departments', 'd')
      .where('u.tenant_id = :tenantId', { tenantId })
      .orderBy('u.username', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    if (search) {
      qb.andWhere('(u.username ILIKE :q OR u.email ILIKE :q)', { q: `%${search}%` });
    }
    const [items, total] = await qb.getManyAndCount();

    // Resolve manager names for the current page only (≤ pageSize lookups).
    const mgrIds = [...new Set(items.map((u) => u.managerId).filter(Boolean))] as string[];
    const mgrMap = new Map<string, string>();
    if (mgrIds.length) {
      const mgrs = await this.users.find({ where: { id: In(mgrIds) }, select: ['id', 'username'] });
      for (const m of mgrs) mgrMap.set(m.id, m.username);
    }

    return {
      items: items.map((u) => ({
        ...u,
        managerName: u.managerId ? mgrMap.get(u.managerId) ?? null : null,
      })),
      total,
      page,
      pageSize,
    };
  }

  // Typeahead directory search — id/username/email/role/grade only, active
  // users, capped. Backs the delegate picker so the client never has to pull
  // the entire user directory into a <select> (which freezes on large tenants).
  search(tenantId: string, q: string, limit = 20) {
    const cap = Math.min(Math.max(limit, 1), 50);
    const qb = this.users.createQueryBuilder('u')
      .select(['u.id', 'u.username', 'u.email', 'u.role', 'u.grade'])
      .where('u.tenant_id = :tenantId AND u.is_active = true', { tenantId })
      .orderBy('u.username', 'ASC')
      .limit(cap);
    const term = q.trim();
    if (term) qb.andWhere('(u.username ILIKE :t OR u.email ILIKE :t)', { t: `%${term}%` });
    return qb.getMany();
  }

  async findById(tenantId: string, id: string) {
    const u = await this.users.findOne({
      where: { id, tenantId },
      relations: { departments: true },
    });
    if (!u) throw new NotFoundException('user not found');
    return u;
  }

  async findByUsername(tenantId: string, username: string) {
    // .addSelect needed because passwordHash has select: false on the
    // entity (avoids accidentally returning it from list endpoints).
    return this.users
      .createQueryBuilder('u')
      .leftJoinAndSelect('u.departments', 'd')
      .addSelect('u.passwordHash')
      .where('u.tenant_id = :tenantId AND u.username = :username', { tenantId, username })
      .getOne();
  }

  async create(tenantId: string, dto: UpsertUserDto) {
    if (!dto.password) throw new ConflictException('password is required for new users');
    const passwordHash = await bcrypt.hash(dto.password, 10);
    const departments = await this.allowedDepartments(tenantId, dto.departmentIds);
    const u = this.users.create({
      tenantId,
      username: dto.username,
      email: dto.email,
      passwordHash,
      mustChangePassword: dto.mustChangePassword ?? false,
      role: dto.role,
      dn: dto.dn,
      grade: dto.grade,
      isActive: dto.isActive ?? true,
      managerId: fkOrNull(dto.managerId) as string | undefined,
      regionAccess: dto.regionAccess ?? [],
      locale: normalizeLocale(dto.locale),
      departments,
    });
    return this.users.save(u);
  }

  async update(tenantId: string, id: string, dto: UpsertUserDto) {
    const existing = await this.findById(tenantId, id);
    existing.username = dto.username ?? existing.username;
    if (dto.email !== undefined) existing.email = dto.email;
    existing.role = dto.role ?? existing.role;
    existing.dn = dto.dn ?? existing.dn;
    existing.grade = dto.grade ?? existing.grade;
    if (dto.isActive !== undefined) existing.isActive = dto.isActive;
    if (dto.managerId !== undefined) existing.managerId = fkOrNull(dto.managerId) as string | undefined;
    if (dto.regionAccess !== undefined) existing.regionAccess = dto.regionAccess;
    if (dto.locale !== undefined) existing.locale = normalizeLocale(dto.locale);
    if (dto.password) existing.passwordHash = await bcrypt.hash(dto.password, 10);
    if (dto.mustChangePassword !== undefined) existing.mustChangePassword = dto.mustChangePassword;
    if (dto.departmentIds !== undefined) {
      existing.departments = await this.allowedDepartments(tenantId, dto.departmentIds);
    }
    return this.users.save(existing);
  }

  // Set a fresh password and clear the force-change flag — used by the
  // self-service change-password flow after a forced first-login reset.
  async setPassword(tenantId: string, id: string, newPassword: string) {
    const u = await this.findById(tenantId, id);
    u.passwordHash = await bcrypt.hash(newPassword, 10);
    u.mustChangePassword = false;
    await this.users.save(u);
    return u;
  }

  async deactivate(tenantId: string, id: string) {
    const u = await this.findById(tenantId, id);
    u.isActive = false;
    await this.users.save(u);
  }

  // Cross-tenant safety: intersect supplied department IDs with the
  // tenant's actual departments table — silently drop foreign IDs.
  // Same defence as v1's userRepo.SetDepartmentIDs (post-security-audit).
  private async allowedDepartments(tenantId: string, ids: string[] | undefined): Promise<Department[]> {
    if (!ids?.length) return [];
    const dedup = Array.from(new Set(ids.filter(Boolean)));
    return this.depts.find({ where: { tenantId, id: In(dedup) } });
  }
}
