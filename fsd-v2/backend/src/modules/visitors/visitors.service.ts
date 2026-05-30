import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Repository } from 'typeorm';
import { Visit, VisitStatus } from './visit.entity';

@Injectable()
export class VisitorsService {
  constructor(@InjectRepository(Visit) private readonly repo: Repository<Visit>) {}

  list(tenantId: string, from?: Date, to?: Date, status?: VisitStatus) {
    const where: any = { tenantId };
    if (from && to) where.expectedAt = Between(from, to);
    if (status) where.status = status;
    return this.repo.find({ where, order: { expectedAt: 'DESC' } });
  }
  async get(tenantId: string, id: string) {
    const r = await this.repo.findOne({ where: { id, tenantId } });
    if (!r) throw new NotFoundException('visit not found');
    return r;
  }
  create(tenantId: string, createdBy: string, dto: Partial<Visit>) {
    return this.repo.save(this.repo.create({
      ...dto, tenantId, createdBy, status: 'Expected',
    }));
  }
  async update(tenantId: string, id: string, dto: Partial<Visit>) {
    const r = await this.get(tenantId, id);
    Object.assign(r, dto, { id: r.id, tenantId: r.tenantId });
    return this.repo.save(r);
  }
  async remove(tenantId: string, id: string) {
    const r = await this.repo.delete({ id, tenantId });
    if (!r.affected) throw new NotFoundException('visit not found');
  }

  // Status transitions. Guards keep the state machine sane —
  // can't check out before checking in, can't cancel after check-out.
  async checkIn(tenantId: string, id: string) {
    const v = await this.get(tenantId, id);
    if (v.status === 'Checked Out' || v.status === 'Cancelled')
      throw new BadRequestException(`cannot check in from ${v.status}`);
    v.status = 'Checked In';
    v.checkedInAt = new Date();
    return this.repo.save(v);
  }
  async checkOut(tenantId: string, id: string) {
    const v = await this.get(tenantId, id);
    if (v.status !== 'Checked In')
      throw new BadRequestException(`cannot check out from ${v.status}`);
    v.status = 'Checked Out';
    v.checkedOutAt = new Date();
    return this.repo.save(v);
  }
  async cancel(tenantId: string, id: string) {
    const v = await this.get(tenantId, id);
    if (v.status === 'Checked Out')
      throw new BadRequestException('already checked out');
    v.status = 'Cancelled';
    return this.repo.save(v);
  }
}
