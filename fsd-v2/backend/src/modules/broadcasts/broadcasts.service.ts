import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import { Broadcast } from './broadcast.entity';

export interface BroadcastInput {
  title: string;
  content: string;
  severity?: string;
  color?: string;
  imageUrl?: string;
  startsAt?: string | Date;
  endsAt?: string | Date;
  filters?: Record<string, any>;
}

@Injectable()
export class BroadcastsService {
  constructor(@InjectRepository(Broadcast) private readonly repo: Repository<Broadcast>) {}

  // Active = the window [startsAt, endsAt] currently contains "now".
  async findActive(tenantId: string, now: Date = new Date()) {
    return this.repo.find({
      where: {
        tenantId,
        startsAt: LessThanOrEqual(now),
        endsAt: MoreThanOrEqual(now),
      },
      order: { startsAt: 'DESC' },
    });
  }

  listAll(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { startsAt: 'DESC' } });
  }

  create(tenantId: string, userId: string, input: BroadcastInput) {
    const b = this.repo.create({
      tenantId,
      createdBy: userId,
      ...this.normalise(input),
    });
    return this.repo.save(b);
  }

  async update(tenantId: string, id: string, input: BroadcastInput) {
    const existing = await this.repo.findOne({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException('broadcast not found');
    Object.assign(existing, this.normalise(input));
    return this.repo.save(existing);
  }

  async remove(tenantId: string, id: string) {
    const res = await this.repo.delete({ id, tenantId });
    if (!res.affected) throw new NotFoundException('broadcast not found');
  }

  private normalise(input: BroadcastInput): Partial<Broadcast> {
    const startsAt = input.startsAt ? new Date(input.startsAt) : new Date();
    const endsAt = input.endsAt
      ? new Date(input.endsAt)
      : new Date(startsAt.getTime() + 24 * 3600 * 1000);
    const filters = { ...(input.filters || {}) };
    const severity = (input.severity || filters.severity || 'info').toLowerCase();
    filters.severity = severity;
    if (input.color) filters.color = input.color;
    return {
      title: input.title.trim(),
      content: input.content.trim(),
      severity,
      color: input.color ?? '',
      imageUrl: input.imageUrl ?? '',
      startsAt,
      endsAt,
      filters,
    };
  }
}
