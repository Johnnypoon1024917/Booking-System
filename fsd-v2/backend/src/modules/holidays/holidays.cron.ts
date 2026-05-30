import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HolidaysService } from './holidays.service';
import { CustomizationService } from '../customization/customization.service';

// Nightly job that refreshes the gov.hk public-holiday feed for every
// tenant that has opted in via tenant customization
// (`govhk_holidays_enabled = true`). Best-effort — a tenant-level failure
// is logged but never aborts the rest of the run.
@Injectable()
export class HolidaysCron {
  private readonly log = new Logger(HolidaysCron.name);

  constructor(
    private readonly holidays: HolidaysService,
    private readonly customization: CustomizationService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightlySync() {
    const tenantIds = await this.holidays.listTenantIds();
    for (const tenantId of tenantIds) {
      try {
        const cz = await this.customization.get(tenantId);
        if (!cz.govhk_holidays_enabled) continue;
        await this.holidays.syncFromGovHK(tenantId, undefined, cz.default_locale || 'en');
      } catch (err) {
        this.log.warn(`gov.hk sync failed for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}
