import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Booking } from './booking.entity';

// PII-free interval. Mirrors v1's freebusy_handler shape: resource_id,
// start, end, status — never the title, organiser, or attendee list.
// External calendar clients only need to know "occupied", not by whom.
export interface BusyInterval {
  resourceId: string;
  start: Date;
  end: Date;
  status: string;
}

@Injectable()
export class FreeBusyService {
  constructor(
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  async list(tenantId: string, start: Date, end: Date, resourceIds?: string[]): Promise<BusyInterval[]> {
    const qb = this.bookings.createQueryBuilder('b')
      .select(['b.resourceId', 'b.startTime', 'b.endTime', 'b.status'])
      .where('b.tenant_id = :t', { t: tenantId })
      .andWhere(`b.status NOT IN ('Cancelled','No Show')`)
      .andWhere('b.start_time < :e AND b.end_time > :s', { s: start, e: end })
      .orderBy('b.start_time', 'ASC');
    if (resourceIds && resourceIds.length) {
      qb.andWhere('b.resource_id IN (:...ids)', { ids: resourceIds });
    }
    const rows = await qb.getMany();
    return rows.map((b) => ({
      resourceId: b.resourceId,
      start: b.startTime,
      end: b.endTime,
      status: b.status,
    }));
  }
}
