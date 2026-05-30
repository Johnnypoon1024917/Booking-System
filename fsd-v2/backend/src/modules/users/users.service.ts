import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from './user.entity';
import { Department } from '../departments/department.entity';

export interface UpsertUserDto {
  username: string;
  email?: string;
  role: string;
  password?: string;
  mustChangePassword?: boolean;
  dn?: string;
  grade?: string;
  isActive?: boolean;
  regionAccess?: string[];
  departmentIds?: string[];
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
      regionAccess: dto.regionAccess ?? [],
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
    if (dto.regionAccess !== undefined) existing.regionAccess = dto.regionAccess;
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
