import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, Logger, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RedisService } from '../redis/redis.service';

// Rate limiter for the unauthenticated auth surface (login, MFA verify, password
// change, SSO/LDAP, WebAuthn). Without it these @Public() endpoints accept
// unlimited attempts — credential stuffing, password/TOTP brute-force, and a
// bcrypt-per-attempt CPU DoS amplifier.
//
// Two backends, same fixed-window-per-IP+route semantics:
//   - Redis (when REDIS_URL is set): a single atomic INCR/PEXPIRE so the window
//     is GLOBAL across every pod behind the load balancer. Without this, N pods
//     means N× the configured limit — the whole point of the limiter is lost in
//     an active-active deployment.
//   - In-memory Map (fallback): per-process window. Correct for single-node, and
//     used automatically if Redis is unavailable so a Redis blip degrades to
//     "still rate-limited per pod" rather than "fails open, no limit at all".

export interface RateLimitOptions {
  limit: number;       // max requests per window
  windowMs: number;    // window length in ms
}

export const RATE_LIMIT_KEY = 'rate_limit';
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

interface Counter { count: number; resetAt: number; }

// Atomic fixed-window counter: INCR, set the TTL only on the first hit of the
// window, return the running count and remaining ms so we can emit Retry-After.
const WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('PTTL', KEYS[1])}
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly log = new Logger(RateLimitGuard.name);
  private readonly hits = new Map<string, Counter>();
  private lastSweep = 0;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()],
    );
    if (!opts) return true; // not a rate-limited route

    const req = ctx.switchToHttp().getRequest<Request>();
    const key = `${this.clientIp(req)}:${req.method}:${req.route?.path ?? req.path}`;

    if (this.redis.enabled && this.redis.cmd) {
      try {
        return await this.checkRedis(key, opts);
      } catch (e) {
        // Redis hiccup: fall back to the in-memory window rather than failing
        // open. Still protects each pod; logs so the operator notices.
        this.log.warn(`redis rate-limit unavailable, falling back to in-memory: ${(e as Error).message}`);
      }
    }
    return this.checkMemory(key, opts);
  }

  private async checkRedis(key: string, opts: RateLimitOptions): Promise<boolean> {
    const [count, ttl] = (await this.redis.cmd!.eval(
      WINDOW_LUA, 1, `rl:${key}`, String(opts.windowMs),
    )) as [number, number];
    if (count > opts.limit) {
      this.reject(ttl);
    }
    return true;
  }

  private checkMemory(key: string, opts: RateLimitOptions): boolean {
    const now = Date.now();
    this.sweep(now);
    const c = this.hits.get(key);
    if (!c || c.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return true;
    }
    if (c.count >= opts.limit) {
      this.reject(c.resetAt - now);
    }
    c.count += 1;
    return true;
  }

  private reject(remainingMs: number): never {
    const retryAfter = Math.max(1, Math.ceil(remainingMs / 1000));
    throw new HttpException(
      { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'too many attempts, please try again later', retryAfter },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  // Use Express's trust-proxy-resolved client IP (AUD-012). main.ts sets
  // `trust proxy` to the number of controlled reverse-proxy hops, so req.ip is
  // derived from the right-most untrusted X-Forwarded-For entry — i.e. the real
  // client, NOT a spoofable left-most header the client fully controls. We must
  // NOT read X-Forwarded-For directly: trusting the left-most value let an
  // attacker mint a fresh counter per request and bypass the limit entirely.
  private clientIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  // Periodically drop expired counters so the in-memory map can't grow unbounded.
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, c] of this.hits) {
      if (c.resetAt <= now) this.hits.delete(k);
    }
  }
}
