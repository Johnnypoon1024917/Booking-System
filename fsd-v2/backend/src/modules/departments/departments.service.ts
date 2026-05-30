import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Department } from './department.entity';

@Injectable()
export class DepartmentsService {
  constructor(@InjectRepository(Department) private readonly repo: Repository<Department>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }

  async create(tenantId: string, dto: { name: string; code?: string; parentId?: string }) {
    const dept = this.repo.create({ ...dto, tenantId });
    return this.repo.save(dept);
  }

  async update(tenantId: string, id: string, dto: { name?: string; code?: string; parentId?: string }) {
    const existing = await this.repo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('department not found');
    Object.assign(existing, dto);
    return this.repo.save(existing);
  }

  async remove(tenantId: string, id: string) {
    const result = await this.repo.delete({ id, tenantId });
    if (!result.affected) throw new NotFoundException('department not found');
  }
}
