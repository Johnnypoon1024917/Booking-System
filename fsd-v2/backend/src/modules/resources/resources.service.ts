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

// Write shape accepted by create/update: the entity columns plus the
// write-only `subResources` list (which is expanded into child rows, not
// stored on the parent).
export type ResourceWriteDto = Partial<Resource> & {
  subResources?: Array<{ id?: string; name: string; capacity?: number }>;
};

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

  async create(tenantId: string, dto: ResourceWriteDto) {
    const { subResources, ...fields } = dto;
    // A space with sub-rooms is a composite parent; otherwise honour whatever
    // compositeMode was supplied (default 'standalone' on the entity).
    if (subResources && subResources.length) fields.compositeMode = 'parent';
    const parent = await this.repo.save(this.repo.create({ ...fields, tenantId }));
    if (subResources && subResources.length) {
      await this.syncSubResources(tenantId, parent, subResources);
    }
    return parent;
  }

  async update(tenantId: string, id: string, dto: ResourceWriteDto) {
    const { subResources, ...fields } = dto;
    const r = await this.get(tenantId, id);
    if (subResources && subResources.length) fields.compositeMode = 'parent';
    Object.assign(r, fields, { id: r.id, tenantId: r.tenantId });
    const saved = await this.repo.save(r);
    if (subResources) await this.syncSubResources(tenantId, saved, subResources);
    return saved;
  }

  // Reconcile a parent's child resources against the editor's list. Upserts by
  // name (case-insensitive): existing child → update capacity; new name →
  // create a child row the booking cross-locking already understands. Children
  // dropped from the list are SOFT-deactivated (isActive=false), never hard
  // deleted, so a child that still holds bookings is never silently destroyed.
  private async syncSubResources(
    tenantId: string, parent: Resource, subs: Array<{ id?: string; name: string; capacity?: number }>,
  ) {
    const existing = await this.repo.find({ where: { tenantId, parentResourceId: parent.id } });
    const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));
    const keepIds = new Set<string>();

    for (const sub of subs) {
      const name = (sub.name || '').trim();
      if (!name) continue;
      const match = byName.get(name.toLowerCase());
      if (match) {
        match.capacity = sub.capacity ?? match.capacity;
        match.isActive = true;
        await this.repo.save(match);
        keepIds.add(match.id);
      } else {
        const child = await this.repo.save(this.repo.create({
          tenantId, name,
          capacity: sub.capacity ?? parent.capacity ?? 1,
          region: parent.region, location: parent.location,
          assetType: parent.assetType,
          requiresApproval: parent.requiresApproval,
          departmentId: parent.departmentId,
          parentResourceId: parent.id, compositeMode: 'child',
          isActive: true,
        }));
        keepIds.add(child.id);
      }
    }
    // Soft-deactivate children the admin removed from the list.
    for (const c of existing) {
      if (!keepIds.has(c.id) && c.isActive) {
        c.isActive = false;
        await this.repo.save(c);
      }
    }
  }

  // Return a parent's active child sub-resources (for the editor to re-hydrate).
  children(tenantId: string, parentResourceId: string) {
    return this.repo.find({
      where: { tenantId, parentResourceId, isActive: true },
      order: { name: 'ASC' },
    });
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
