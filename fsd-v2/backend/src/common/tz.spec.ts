import { zonedTimeToUtc } from './tz';

// QA #1: the booker's search window is a wall-clock time in the tenant's
// timezone, but bookings are stored as true UTC instants. The availability
// query only works if the wall clock is reinterpreted in the tenant zone.
describe('zonedTimeToUtc', () => {
  it('converts a Hong Kong wall clock to the correct UTC instant', () => {
    // 15:00 in Asia/Hong_Kong (UTC+8, no DST) is 07:00Z.
    const d = zonedTimeToUtc('2026-05-29', '15:00', 'Asia/Hong_Kong');
    expect(d.toISOString()).toBe('2026-05-29T07:00:00.000Z');
  });

  it('matches a booking made at the same local time', () => {
    // A booker in HK creating "15:00" sends new Date('2026-05-29T15:00:00')
    // .toISOString() — i.e. 07:00Z. The search window must resolve to the
    // same instant so the overlap check fires.
    const search = zonedTimeToUtc('2026-05-29', '15:00', 'Asia/Hong_Kong');
    const bookingLocalHk = new Date('2026-05-29T07:00:00.000Z'); // 15:00 HKT
    expect(search.getTime()).toBe(bookingLocalHk.getTime());
  });

  it('handles midnight (00:00) all-day starts', () => {
    const d = zonedTimeToUtc('2026-05-29', '00:00', 'Asia/Hong_Kong');
    // 00:00 HKT on the 29th is 16:00Z on the 28th.
    expect(d.toISOString()).toBe('2026-05-28T16:00:00.000Z');
  });

  it('defaults to Asia/Hong_Kong when no zone given', () => {
    const a = zonedTimeToUtc('2026-05-29', '15:00');
    const b = zonedTimeToUtc('2026-05-29', '15:00', 'Asia/Hong_Kong');
    expect(a.getTime()).toBe(b.getTime());
  });

  it('respects a UTC zone (no shift)', () => {
    const d = zonedTimeToUtc('2026-05-29', '15:00', 'UTC');
    expect(d.toISOString()).toBe('2026-05-29T15:00:00.000Z');
  });

  it('applies DST for a northern-hemisphere summer zone', () => {
    // America/New_York in May is EDT (UTC-4): 09:00 local = 13:00Z.
    const d = zonedTimeToUtc('2026-05-29', '09:00', 'America/New_York');
    expect(d.toISOString()).toBe('2026-05-29T13:00:00.000Z');
  });
});
