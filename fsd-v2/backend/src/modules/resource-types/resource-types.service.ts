import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ResourceType } from './resource-type.entity';

@Injectable()
export class ResourceTypesService {
  constructor(@InjectRepository(ResourceType) private readonly repo: Repository<ResourceType>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { displayOrder: 'ASC', label: 'ASC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('resource type not found');
    return r;
  }
  create(tenantId: string, dto: Partial<ResourceType>) {
    return this.repo.save(this.repo.create({ ...dto, tenantId }));
  }
  async update(tenantId: string, id: string, dto: Partial<ResourceType>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }
  async remove(tenantId: string, id: string) {
    const existing = await this.get(tenantId, id);
    if (existing.isBuiltin) throw new NotFoundException('built-in types cannot be deleted');
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('resource type not found');
  }
}
