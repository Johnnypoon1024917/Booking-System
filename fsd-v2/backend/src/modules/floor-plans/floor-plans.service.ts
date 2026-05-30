import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FloorPlan } from './floor-plan.entity';

@Injectable()
export class FloorPlansService {
  constructor(@InjectRepository(FloorPlan) private readonly repo: Repository<FloorPlan>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { isDefault: 'DESC', name: 'ASC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('floor plan not found');
    return r;
  }
  create(tenantId: string, dto: Partial<FloorPlan>) {
    return this.repo.save(this.repo.create({ ...dto, tenantId }));
  }
  async update(tenantId: string, id: string, dto: Partial<FloorPlan>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }
  async remove(tenantId: string, id: string) {
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('floor plan not found');
  }
  // Single default per tenant — clear then set in one transaction.
  async setDefault(tenantId: string, id: string) {
    await this.repo.manager.transaction(async (m) => {
      await m.update(FloorPlan, { tenantId }, { isDefault: false });
      await m.update(FloorPlan, { tenantId, id }, { isDefault: true });
    });
    return this.get(tenantId, id);
  }
  async duplicate(tenantId: string, sourceId: string, newName: string) {
    const src = await this.get(tenantId, sourceId);
    return this.repo.save(this.repo.create({
      tenantId, name: newName, imageUrl: src.imageUrl,
      shapes: src.shapes, pins: src.pins, isDefault: false,
    }));
  }
}
