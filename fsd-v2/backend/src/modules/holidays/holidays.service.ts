import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Holiday } from './holiday.entity';
import { GovHKHolidayClient } from './govhk.client';

export interface HolidayInput {
  holidayDate: string;
  name?: string;
  scope?: string;
  isBlocker?: boolean;
}

@Injectable()
export class HolidaysService {
  private readonly log = new Logger(HolidaysService.name);

  constructor(
    @InjectRepository(Holiday) private readonly repo: Repository<Holiday>,
    private readonly govhk: GovHKHolidayClient,
  ) {}

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { holidayDate: 'ASC' } });
  }

  create(tenantId: string, userId: string | undefined, input: HolidayInput) {
    return this.repo.save(this.repo.create({
      tenantId,
      createdBy: userId,
      holidayDate: input.holidayDate,
      name: input.name ?? '',
      scope: input.scope ?? 'manual',
      isBlocker: input.isBlocker ?? true,
    }));
  }

  async update(tenantId: string, id: string, input: HolidayInput) {
    const h = await this.repo.findOne({ where: { id, tenantId } });
    if (!h) throw new NotFoundException('holiday not found');
    h.holidayDate = input.holidayDate;
    h.name = input.name ?? h.name;
    if (input.scope) h.scope = input.scope;
    if (typeof input.isBlocker === 'boolean') h.isBlocker = input.isBlocker;
    return this.repo.save(h);
  }

  async remove(tenantId: string, id: string) {
    const res = await this.repo.delete({ id, tenantId });
    if (!res.affected) throw new NotFoundException('holiday not found');
  }

  // Pulls the live gov.hk feed and upserts rows keyed on (tenant, date).
  // Returns { imported, skipped } so the SPA can show a confirmation toast.
  async syncFromGovHK(tenantId: string, userId: string | undefined, locale = 'en') {
    const feed = await this.govhk.fetch(locale);
    let imported = 0;
    let skipped = 0;
    for (const e of feed) {
      const existing = await this.repo.findOne({
        where: { tenantId, holidayDate: e.date },
      });
      if (existing) {
        // Refresh the name from the official feed but leave manual entries
        // alone (don't overwrite an admin's custom label).
        if (existing.scope === 'govhk' && existing.name !== e.name) {
          existing.name = e.name;
          await this.repo.save(existing);
        }
        skipped++;
        continue;
      }
      await this.repo.save(this.repo.create({
        tenantId,
        createdBy: userId,
        holidayDate: e.date,
        name: e.name,
        scope: 'govhk',
        isBlocker: true,
      }));
      imported++;
    }
    this.log.log(`gov.hk sync (tenant=${tenantId}): imported=${imported} skipped=${skipped}`);
    return { imported, skipped };
  }

  // Tenants used by the nightly cron job. The cron has no request context,
  // so the service handles the iteration itself.
  async listTenantIds(): Promise<string[]> {
    const rows = await this.repo.manager.query<{ id: string }[]>(`SELECT id FROM tenants`);
    return rows.map((r) => r.id);
  }
}
