import type { Subscription } from 'rxjs';

// The per-user SSE cap is read from env at module load, so set it BEFORE the
// gateway module is required.
process.env.SSE_MAX_PER_USER = '2';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { RealtimeGateway } = require('./realtime.gateway');

const flush = () => new Promise((r) => setImmediate(r));

describe('RealtimeGateway (Redis disabled — single-process path)', () => {
  const redisDisabled = { enabled: false, cmd: undefined, subscribe: () => false, publish: async () => false } as any;
  const metrics = { sseInc: jest.fn(), sseDec: jest.fn() } as any;
  let gw: any;

  beforeEach(() => { gw = new RealtimeGateway(redisDisabled, metrics); });

  it('delivers an emitted event to a subscriber of the same tenant, with an id', async () => {
    const got: any[] = [];
    const sub: Subscription = gw.streamFor('tenant-a', 'user-1').subscribe((m: any) => got.push(m));
    gw.emit({ type: 'booking.created', tenantId: 'tenant-a', bookingId: 'b1' });
    await flush();
    sub.unsubscribe();
    expect(got).toHaveLength(1);
    expect(got[0].data.tenantId).toBe('tenant-a');
    expect(got[0].data.type).toBe('booking.created');
    expect(typeof got[0].id).toBe('string'); // surfaced as the SSE event id
  });

  it('filters cross-tenant events before the wire', async () => {
    const got: any[] = [];
    const sub = gw.streamFor('tenant-a', 'user-1').subscribe((m: any) => got.push(m));
    gw.emit({ type: 'booking.created', tenantId: 'tenant-b' }); // different tenant
    await flush();
    sub.unsubscribe();
    expect(got).toHaveLength(0);
  });

  it('enforces the per-user concurrent connection cap', () => {
    const subs: Subscription[] = [];
    const open = () =>
      new Promise<{ ok: boolean; err?: any }>((resolve) => {
        const s = gw.streamFor('tenant-a', 'user-x').subscribe({
          error: (err: any) => resolve({ ok: false, err }),
        });
        subs.push(s);
        // No synchronous error → the subscription was accepted.
        resolve({ ok: true });
      });

    return (async () => {
      expect((await open()).ok).toBe(true); // 1
      expect((await open()).ok).toBe(true); // 2 (cap = 2)
      const third = await open();           // 3 over cap
      expect(third.ok).toBe(false);
      expect(third.err?.status).toBe(429);
      subs.forEach((s) => s.unsubscribe());
    })();
  });

  it('releases the slot on disconnect so a user can reconnect', async () => {
    const s1 = gw.streamFor('tenant-a', 'user-y').subscribe();
    const s2 = gw.streamFor('tenant-a', 'user-y').subscribe();
    s1.unsubscribe(); // free one slot
    let accepted = true;
    gw.streamFor('tenant-a', 'user-y').subscribe({ error: () => { accepted = false; } });
    await flush();
    expect(accepted).toBe(true);
    s2.unsubscribe();
  });
});
