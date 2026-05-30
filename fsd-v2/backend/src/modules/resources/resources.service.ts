import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Resource } from './resource.entity';

export interface SearchCriteria {
  tenantId: string;
  location?: string;
  assetType?: string;
  capacity?: number;
  start: Date;
  end: Date;
}

@Injectable()
export class ResourcesService {
  constructor(@InjectRepository(Resource) private readonly repo: Repository<Resource>) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }

  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('resource not found');
    return r;
  }

  create(tenantId: string, dto: Partial<Resource>) {
    return this.repo.save(this.repo.create({ ...dto, tenantId }));
  }

  async update(tenantId: string, id: string, dto: Partial<Resource>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }

  async remove(tenantId: string, id: string) {
    const result = await this.repo.delete({ id, tenantId });
    if (!result.affected) throw new NotFoundException('resource not found');
  }

  // Find available rooms in [start, end]. Excludes inactive rooms,
  // optionally filters by location / asset type / capacity, then
  // subtracts the set of rooms with a conflicting booking in the
  // window via a NOT IN subquery against bookings.
  async findAvailable(c: SearchCriteria) {
    const qb = this.repo.createQueryBuilder('r')
      .where('r.tenant_id = :t', { t: c.tenantId })
      .andWhere('r.is_active = TRUE')
      .andWhere(
        `r.id NOT IN (
          SELECT b.resource_id FROM bookings b
          WHERE b.tenant_id = :t
            AND b.status NOT IN ('Cancelled','No Show')
            AND tstzrange(b.start_time, b.end_time, '[)')
                && tstzrange(:start, :end, '[)')
        )`,
        { start: c.start, end: c.end },
      );
    if (c.location) qb.andWhere('r.location = :location', { location: c.location });
    if (c.assetType) qb.andWhere('r.asset_type = :at', { at: c.assetType });
    if (c.capacity && c.capacity > 0) qb.andWhere('r.capacity >= :cap', { cap: c.capacity });
    return qb.orderBy('r.name', 'ASC').getMany();
  }

  byIds(tenantId: string, ids: string[]) {
    if (!ids.length) return Promise.resolve([] as Resource[]);
    return this.repo.find({ where: { tenantId, id: In(ids) } });
  }
}
