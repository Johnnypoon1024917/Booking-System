import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HolidaysService } from './holidays.service';
import { CustomizationService } from '../customization/customization.service';
import { RedisService } from '../../common/redis/redis.service';

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
    private readonly redis: RedisService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async nightlySync() {
    // Run on exactly one instance — otherwise N pods all hammer gov.hk and
    // upsert the same rows. 10-min lock comfortably covers the run.
    if (!(await this.redis.tryLock('cron:holidays-nightly', 10 * 60_000))) return;
    const tenantIds = await this.holidays.listTenantIds();
    for (const tenantId of tenantIds) {
      try {
        const cz = await this.customization.get(tenantId);
        if (!cz.govhk_holidays_enabled) continue;
        const regions: string[] = Array.isArray(cz.govhk_holiday_regions) ? cz.govhk_holiday_regions : [];
        await this.holidays.syncFromGovHK(tenantId, undefined, cz.default_locale || 'en', regions);
      } catch (err) {
        this.log.warn(`gov.hk sync failed for tenant ${tenantId}: ${(err as Error).message}`);
      }
    }
  }
}
