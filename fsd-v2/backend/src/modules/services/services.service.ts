import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Service, BookingService } from './service.entity';

@Injectable()
export class ServicesService {
  constructor(
    @InjectRepository(Service) private readonly repo: Repository<Service>,
    @InjectRepository(BookingService) private readonly bsRepo: Repository<BookingService>,
  ) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { name: 'ASC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('service not found');
    return r;
  }
  create(tenantId: string, dto: Partial<Service>) {
    return this.repo.save(this.repo.create({ ...dto, tenantId }));
  }
  async update(tenantId: string, id: string, dto: Partial<Service>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }
  async remove(tenantId: string, id: string) {
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('service not found');
  }

  // Attach a service to a booking. Snapshots unit price so later catalog
  // edits don't restate historical invoices.
  async attachToBooking(tenantId: string, bookingId: string, serviceId: string, quantity = 1, note = '') {
    const svc = await this.get(tenantId, serviceId);
    return this.bsRepo.save(this.bsRepo.create({
      tenantId, bookingId, serviceId, quantity, note,
      unitPriceCents: svc.priceCents,
    }));
  }
  listForBooking(tenantId: string, bookingId: string) {
    return this.bsRepo.find({ where: { tenantId, bookingId } });
  }
  async detachFromBooking(tenantId: string, bookingId: string, id: string) {
    const r = await this.bsRepo.delete({ id, tenantId, bookingId });
    if (!r.affected) throw new NotFoundException('booking service not found');
  }
}
