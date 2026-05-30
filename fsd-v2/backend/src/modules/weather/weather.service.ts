import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { HKOClient, WeatherReport } from './hko.client';

// In-memory weather cache. The HKO endpoint is fine with frequent polling,
// but every dashboard load hitting it directly would be wasteful and would
// noticeably slow the SPA. We refresh every 30 minutes; the dashboard
// returns the cached snapshot in microseconds.
@Injectable()
export class WeatherService {
  private readonly log = new Logger(WeatherService.name);
  private cache: WeatherReport | null = null;
  private cachedAt = 0;
  private readonly ttlMs = 30 * 60 * 1000;

  constructor(private readonly hko: HKOClient) {}

  // Called by the cron job and lazily by the controller when the cache
  // is empty (e.g. first request after startup before the cron has run).
  async refresh(): Promise<WeatherReport> {
    try {
      const rep = await this.hko.currentWeather();
      this.cache = rep;
      this.cachedAt = Date.now();
      return rep;
    } catch (err) {
      this.log.warn(`HKO refresh failed: ${(err as Error).message}`);
      if (this.cache) return this.cache;
      // Degrade to an empty report rather than failing the dashboard.
      return { tempC: 0, signals: [], updatedAt: new Date().toISOString() };
    }
  }

  async current(): Promise<WeatherReport> {
    if (this.cache && Date.now() - this.cachedAt < this.ttlMs) return this.cache;
    return this.refresh();
  }

  // Polls every 30 minutes (well within HKO's rate budget) so the
  // dashboard widget is essentially always served from memory.
  @Cron(CronExpression.EVERY_30_MINUTES)
  async scheduledRefresh() {
    await this.refresh();
  }
}
