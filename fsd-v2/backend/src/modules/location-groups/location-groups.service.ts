import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LocationGroup } from './location-group.entity';

@Injectable()
export class LocationGroupsService {
  constructor(@InjectRepository(LocationGroup) private readonly repo: Repository<LocationGroup>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('group not found');
    return r;
  }
  create(tenantId: string, dto: Partial<LocationGroup>) {
    return this.repo.save(this.repo.create({ ...dto, tenantId }));
  }
  async update(tenantId: string, id: string, dto: Partial<LocationGroup>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }
  async remove(tenantId: string, id: string) {
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('group not found');
  }
}
