import { RecurrenceService } from './recurrence.service';

// QA #4: the recurrence expansion must produce one occurrence per `count`
// with the right cadence. The bug was that the SPA hit /bookings (which
// ignores recurrence) instead of /bookings/recurring — but the expansion
// itself must also be correct, so we exercise it directly here.
//
// `expand` is a pure private method (no DB), so we instantiate the service
// with stub repos and reach it via `as any`.
function makeService(): any {
  return new RecurrenceService({} as any, {} as any, {} as any, {} as any);
}

function call(dto: any) {
  const svc = makeService();
  const firstStart = new Date(dto.firstStart);
  const firstEnd = new Date(dto.firstEnd);
  return svc.expand(dto, firstStart, firstEnd, [] as number[]) as Array<{ start: Date; end: Date }>;
}

describe('RecurrenceService.expand', () => {
  const base = { firstStart: '2026-05-29T07:00:00.000Z', firstEnd: '2026-05-29T08:00:00.000Z' };

  it('daily x10 yields 10 occurrences one day apart', () => {
    const occ = call({ ...base, pattern: 'daily', count: 10 });
    expect(occ).toHaveLength(10);
    const dayMs = 24 * 3600 * 1000;
    for (let i = 1; i < occ.length; i++) {
      expect(+occ[i].start - +occ[i - 1].start).toBe(dayMs);
    }
    // Duration is preserved (1h).
    expect(+occ[0].end - +occ[0].start).toBe(3600 * 1000);
  });

  it('bi-weekly steps 14 days', () => {
    const occ = call({ ...base, pattern: 'bi-weekly', count: 3 });
    expect(occ).toHaveLength(3);
    expect(+occ[1].start - +occ[0].start).toBe(14 * 24 * 3600 * 1000);
  });

  it('caps at MAX_OCCURRENCES (100)', () => {
    const occ = call({ ...base, pattern: 'daily', count: 9999 });
    expect(occ.length).toBeLessThanOrEqual(100);
  });

  it('weekly produces the requested count', () => {
    const occ = call({ ...base, pattern: 'weekly', count: 4 });
    expect(occ).toHaveLength(4);
    expect(+occ[1].start - +occ[0].start).toBe(7 * 24 * 3600 * 1000);
  });
});
