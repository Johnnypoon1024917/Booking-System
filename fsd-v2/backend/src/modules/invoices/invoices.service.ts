import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Invoice, InvoiceStatus } from './invoice.entity';
import { BookingService } from '../services/service.entity';
import { Booking } from '../bookings/booking.entity';

@Injectable()
export class InvoicesService {
  constructor(
    @InjectRepository(Invoice) private readonly repo: Repository<Invoice>,
    @InjectRepository(BookingService) private readonly bs: Repository<BookingService>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
  ) {}

  list(tenantId: string, status?: InvoiceStatus) {
    return this.repo.find({
      where: status ? { tenantId, status } : { tenantId },
      order: { period: 'DESC' },
    });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('invoice not found');
    return r;
  }
  async remove(tenantId: string, id: string) {
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('invoice not found');
  }

  // Materialise drafts for `period` (YYYY-MM). Walks booking_services
  // for the period, groups by booking owner's departmentId, writes one
  // Draft invoice per department. Existing drafts for the same period
  // are replaced — issued/paid invoices are left alone.
  async runRollup(tenantId: string, period: string, taxRate = 0) {
    if (!/^\d{4}-\d{2}$/.test(period))
      throw new BadRequestException('period must be YYYY-MM');
    const [y, m] = period.split('-').map((n) => parseInt(n, 10));
    const start = new Date(Date.UTC(y, m - 1, 1));
    const end = new Date(Date.UTC(y, m, 1));

    // Join booking_services -> bookings -> user_departments to get the
    // chargeback department. Users can belong to multiple departments;
    // we pick the first one returned by the join (alphabetical via dept
    // id), matching v1's "primary cost-centre" convention. Booking
    // status filter mirrors v1 — only confirmed/checked-in count.
    const rows = await this.bs.createQueryBuilder('bs')
      .innerJoin(Booking, 'b', 'b.id = bs.booking_id AND b.tenant_id = :t', { t: tenantId })
      .leftJoin('user_departments', 'ud', 'ud.user_id = b.user_id')
      .where('bs.tenant_id = :t', { t: tenantId })
      .andWhere('b.start_time >= :s AND b.start_time < :e', { s: start, e: end })
      .andWhere(`b.status IN ('Confirmed','Checked In')`)
      .select([
        'bs.id AS id', 'bs.booking_id AS "bookingId"',
        'bs.quantity AS quantity', 'bs.unit_price_cents AS "unitPriceCents"',
        'ud.department_id AS "departmentId"', 'b.title AS title',
      ])
      .getRawMany<{
        id: string; bookingId: string; quantity: number;
        unitPriceCents: number; departmentId: string | null; title: string;
      }>();

    // Bucket by department; first-seen wins when a user has multiples.
    const buckets = new Map<string, typeof rows>();
    const seenBookings = new Set<string>();
    for (const r of rows) {
      if (seenBookings.has(r.id)) continue;
      seenBookings.add(r.id);
      const k = r.departmentId ?? '__none__';
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k)!.push(r);
    }

    // Replace prior drafts for this period.
    await this.repo.delete({ tenantId, period, status: 'Draft' });

    const out: Invoice[] = [];
    for (const [dept, lines] of buckets) {
      const renderedLines = lines.map((l) => ({
        bookingId: l.bookingId,
        description: l.title,
        quantity: l.quantity,
        unitCents: l.unitPriceCents,
        lineCents: l.quantity * l.unitPriceCents,
      }));
      const subtotal = renderedLines.reduce((s, l) => s + l.lineCents, 0);
      const tax = Math.round(subtotal * taxRate);
      const saved = await this.repo.save(this.repo.create({
        tenantId, period,
        departmentId: dept === '__none__' ? undefined : dept,
        lines: renderedLines,
        subtotalCents: subtotal, taxCents: tax, totalCents: subtotal + tax,
        status: 'Draft',
      }));
      out.push(saved);
    }
    return out;
  }

  async setStatus(tenantId: string, id: string, status: InvoiceStatus) {
    const inv = await this.get(tenantId, id);
    inv.status = status;
    if (status === 'Issued') inv.issuedAt = new Date();
    if (status === 'Paid') inv.paidAt = new Date();
    return this.repo.save(inv);
  }
}
