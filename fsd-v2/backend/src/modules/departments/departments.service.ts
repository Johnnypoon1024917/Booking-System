import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './department.entity';

interface DeptInput { name?: string; code?: string; parentId?: string; headUserId?: string }

// '' / whitespace → null (clear the FK); otherwise the trimmed id. Keeps an
// empty string from being written into the uuid head_user_id column.
function fkOrNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? null : t;
}

@Injectable()
export class DepartmentsService {
  constructor(@InjectRepository(Department) private readonly repo: Repository<Department>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }

  async create(tenantId: string, dto: DeptInput) {
    const dept = this.repo.create({ ...dto, tenantId, headUserId: fkOrNull(dto.headUserId) as string | undefined });
    return this.repo.save(dept);
  }

  async update(tenantId: string, id: string, dto: DeptInput) {
    const existing = await this.repo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('department not found');
    // headUserId is normalised separately so '' clears it (writes NULL) rather
    // than being copied verbatim into a uuid column.
    const { headUserId, ...rest } = dto;
    Object.assign(existing, rest);
    if (headUserId !== undefined) existing.headUserId = fkOrNull(headUserId) as string | undefined;
    return this.repo.save(existing);
  }

  async remove(tenantId: string, id: string) {
    const result = await this.repo.delete({ id, tenantId });
    if (!result.affected) throw new NotFoundException('department not found');
  }
}
