import { ExecutionContext } from '@nestjs/common';
import { RateLimitGuard, RateLimitOptions } from './rate-limit.guard';

// Builds a fake ExecutionContext whose handler carries the given rate-limit
// options and whose request looks like a login attempt from one IP.
function ctxFor(opts: RateLimitOptions | undefined, ip = '1.2.3.4'): ExecutionContext {
  const reflectorReturns = opts;
  const req = { ip, method: 'POST', route: { path: '/auth/login' }, path: '/auth/login' };
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  (ctx as any).__opts = reflectorReturns;
  return ctx;
}

describe('RateLimitGuard (in-memory fallback, Redis disabled)', () => {
  const redisDisabled = { enabled: false } as any;

  function guardWith(opts: RateLimitOptions | undefined) {
    const reflector = { getAllAndOverride: () => opts } as any;
    return new RateLimitGuard(reflector, redisDisabled);
  }

  it('passes through routes with no @RateLimit metadata', async () => {
    const guard = guardWith(undefined);
    await expect(guard.canActivate(ctxFor(undefined))).resolves.toBe(true);
  });

  it('allows up to the limit, then throws 429', async () => {
    const opts = { limit: 2, windowMs: 10_000 };
    const guard = guardWith(opts);
    const ctx = ctxFor(opts);
    await expect(guard.canActivate(ctx)).resolves.toBe(true); // 1
    await expect(guard.canActivate(ctx)).resolves.toBe(true); // 2
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 }); // 3 over
  });

  it('keeps separate windows per client IP', async () => {
    const opts = { limit: 1, windowMs: 10_000 };
    const guard = guardWith(opts);
    await expect(guard.canActivate(ctxFor(opts, '1.1.1.1'))).resolves.toBe(true);
    await expect(guard.canActivate(ctxFor(opts, '1.1.1.1'))).rejects.toMatchObject({ status: 429 });
    // A different IP is unaffected.
    await expect(guard.canActivate(ctxFor(opts, '2.2.2.2'))).resolves.toBe(true);
  });

  it('resets after the window elapses', async () => {
    const opts = { limit: 1, windowMs: 20 };
    const guard = guardWith(opts);
    const ctx = ctxFor(opts, '3.3.3.3');
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ status: 429 });
    await new Promise((r) => setTimeout(r, 30));
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
