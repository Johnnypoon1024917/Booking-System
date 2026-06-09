import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Service, BookingService } from './service.entity';
import { Booking } from '../bookings/booking.entity';
import { AdminRoles, Role } from '../../common/decorators/roles.decorator';

@Injectable()
export class ServicesService {
  constructor(
    @InjectRepository(Service) private readonly repo: Repository<Service>,
    @InjectRepository(BookingService) private readonly bsRepo: Repository<BookingService>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  // Authorization gate (AUD-031): booking add-ons (catering, IT, billing
  // line-items) are booking-adjacent state, so only the booking owner or an
  // admin may read or mutate them. Returns the booking so callers can reuse it.
  private async assertBookingAccess(tenantId: string, bookingId: string, userId: string, role: string): Promise<Booking> {
    const b = await this.bookings.findOne({ where: { id: bookingId, tenantId } });
    if (!b) throw new NotFoundException('booking not found');
    if (b.userId !== userId && !AdminRoles.includes(role as Role)) throw new ForbiddenException();
    return b;
  }

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
  async attachToBooking(tenantId: string, userId: string, role: string, bookingId: string, serviceId: string, quantity = 1, note = '') {
    await this.assertBookingAccess(tenantId, bookingId, userId, role);
    const svc = await this.get(tenantId, serviceId);
    return this.bsRepo.save(this.bsRepo.create({
      tenantId, bookingId, serviceId, quantity, note,
      unitPriceCents: svc.priceCents,
    }));
  }
  async listForBooking(tenantId: string, userId: string, role: string, bookingId: string) {
    await this.assertBookingAccess(tenantId, bookingId, userId, role);
    return this.bsRepo.find({ where: { tenantId, bookingId } });
  }
  async detachFromBooking(tenantId: string, userId: string, role: string, bookingId: string, id: string) {
    await this.assertBookingAccess(tenantId, bookingId, userId, role);
    const r = await this.bsRepo.delete({ id, tenantId, bookingId });
    if (!r.affected) throw new NotFoundException('booking service not found');
  }
}
