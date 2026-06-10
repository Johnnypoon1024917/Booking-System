// Ensure the service constructs in DISABLED mode (no REDIS_URL), so the spec
// never opens a real connection. Must clear the env BEFORE importing the module.
const savedUrl = process.env.REDIS_URL;
beforeAll(() => { delete process.env.REDIS_URL; });
afterAll(() => { if (savedUrl !== undefined) process.env.REDIS_URL = savedUrl; });

import { RedisService } from './redis.service';

describe('RedisService (disabled / in-memory fallback)', () => {
  let svc: RedisService;
  beforeEach(() => { svc = new RedisService(); });
  afterEach(async () => { await svc.onModuleDestroy(); });

  it('reports disabled and exposes no command client', () => {
    expect(svc.enabled).toBe(false);
    expect(svc.cmd).toBeUndefined();
  });

  it('publish() is a no-op returning false (caller falls back to local delivery)', async () => {
    await expect(svc.publish('ch', 'msg')).resolves.toBe(false);
  });

  it('subscribe() returns false so callers keep their in-memory path', () => {
    expect(svc.subscribe('ch', () => undefined)).toBe(false);
  });

  it('tryLock() fails OPEN when disabled (single instance always wins)', async () => {
    await expect(svc.tryLock('cron:x', 1000)).resolves.toBe(true);
  });

  it('ping() reports healthy when disabled (nothing to be unhealthy about)', async () => {
    await expect(svc.ping()).resolves.toBe(true);
  });
});
