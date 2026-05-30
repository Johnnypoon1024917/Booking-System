import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

// gov.hk publishes the official HK public-holiday ICS feed at these
// stable URLs (https://www.1823.gov.hk/common/ical/). We import nightly
// so admins don't have to maintain holidays by hand.
const GOVHK_ICAL_URLS: Record<string, string> = {
  en: 'https://www.1823.gov.hk/common/ical/en.ics',
  'zh-hant': 'https://www.1823.gov.hk/common/ical/tc.ics',
  'zh-hans': 'https://www.1823.gov.hk/common/ical/sc.ics',
};

export interface GovHKHoliday {
  date: string;   // ISO YYYY-MM-DD
  name: string;
}

@Injectable()
export class GovHKHolidayClient {
  private readonly log = new Logger(GovHKHolidayClient.name);

  async fetch(locale = 'en'): Promise<GovHKHoliday[]> {
    const url = GOVHK_ICAL_URLS[locale.toLowerCase()] ?? GOVHK_ICAL_URLS.en;
    const res = await axios.get<string>(url, { timeout: 15_000, responseType: 'text' });
    return this.parseICS(res.data);
  }

  // Minimal RFC 5545 parse — we only care about VEVENT/DTSTART;VALUE=DATE
  // and SUMMARY. The gov.hk feed is well-formed and trivially simple,
  // so a hand-rolled parser is much smaller than pulling in a lib.
  parseICS(body: string): GovHKHoliday[] {
    const out: GovHKHoliday[] = [];
    let inEvent = false;
    let date = '';
    let name = '';
    for (const raw of body.split(/\r?\n/)) {
      // Skip RFC 5545 continuation lines (start with space/tab).
      if (/^[ \t]/.test(raw)) continue;
      const line = raw.trim();
      if (line === 'BEGIN:VEVENT') { inEvent = true; date = ''; name = ''; continue; }
      if (line === 'END:VEVENT') {
        if (inEvent && date) out.push({ date, name });
        inEvent = false;
        continue;
      }
      if (!inEvent) continue;
      if (line.startsWith('DTSTART')) {
        const v = line.substring(line.lastIndexOf(':') + 1).trim();
        // e.g. "20260101"
        if (/^\d{8}$/.test(v)) {
          date = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
        }
      } else if (line.startsWith('SUMMARY')) {
        const idx = line.indexOf(':');
        if (idx > 0) name = this.unescapeICS(line.substring(idx + 1).trim());
      }
    }
    return out;
  }

  private unescapeICS(s: string): string {
    return s.replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/gi, '\n').replace(/\\\\/g, '\\');
  }
}
