import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// HKO open-data endpoints — stable URLs (https://data.weather.gov.hk).
const HKO_WARN_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=warnsum&lang=en';
const HKO_CURRENT_URL = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';

export interface WeatherSignal {
  code: string;         // 'T1' | 'T3' | 'T8' | 'T10' | 'BLACK_RAIN' | …
  severity: number;     // 1 (mild) … 10 (extreme)
  description: string;
  issuedAt?: string;    // ISO
}

export interface WeatherReport {
  tempC: number;
  signals: WeatherSignal[];
  updatedAt: string;
}

@Injectable()
export class HKOClient {
  private readonly log = new Logger(HKOClient.name);

  async currentWeather(): Promise<WeatherReport> {
    const [signals, current] = await Promise.allSettled([
      this.currentSignals(),
      axios.get(HKO_CURRENT_URL, { timeout: 8_000 }),
    ]);

    const out: WeatherReport = {
      tempC: 0,
      signals: signals.status === 'fulfilled' ? signals.value : [],
      updatedAt: new Date().toISOString(),
    };

    if (current.status === 'fulfilled') {
      const raw = current.value.data as any;
      // The hottest reading across stations is the safety-relevant one.
      for (const d of raw?.temperature?.data ?? []) {
        if (typeof d.value === 'number' && d.value > out.tempC) out.tempC = d.value;
      }
      if (raw?.temperature?.recordTime) out.updatedAt = raw.temperature.recordTime;
    }
    return out;
  }

  async currentSignals(): Promise<WeatherSignal[]> {
    const res = await axios.get(HKO_WARN_URL, { timeout: 8_000 });
    const raw = (res.data ?? {}) as Record<string, { name?: string; code?: string; issueTime?: string }>;
    const out: WeatherSignal[] = [];
    for (const v of Object.values(raw)) {
      const sig = this.classify(v.code ?? '', v.name ?? '');
      if (!sig) continue;
      out.push({ ...sig, issuedAt: v.issueTime });
    }
    return out;
  }

  // Internal taxonomy — we collapse HKO codes into a shape useful for
  // the booking exception workflow (T8+ / Black Rain auto-suspends bookings).
  private classify(code: string, name: string): WeatherSignal | null {
    const c = code.toUpperCase();
    const n = name.toUpperCase();
    if (c.includes('TC10')) return { code: 'T10', severity: 10, description: name };
    if (c.includes('TC9'))  return { code: 'T9',  severity: 9,  description: name };
    if (c.includes('TC8'))  return { code: 'T8',  severity: 8,  description: name };
    if (c.includes('TC3'))  return { code: 'T3',  severity: 3,  description: name };
    if (c.includes('TC1'))  return { code: 'T1',  severity: 1,  description: name };
    if (c === 'WRAINB' || n.includes('BLACK'))  return { code: 'BLACK_RAIN', severity: 9, description: name };
    if (c === 'WRAINR' || n.includes('RED'))    return { code: 'RED_RAIN',   severity: 7, description: name };
    if (c === 'WRAINA' || n.includes('AMBER'))  return { code: 'AMBER_RAIN', severity: 4, description: name };
    return null;
  }
}

// Helper exported for callers that want the booking-suspension rule
// without re-implementing the threshold.
export function suspendsBookings(s: WeatherSignal): boolean {
  return s.severity >= 8;
}
