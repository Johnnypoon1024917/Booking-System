import {
  CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

// Lightweight in-memory rate limiter for the unauthenticated auth surface
// (login, MFA verify, password change, SSO/LDAP, WebAuthn). Without it these
// @Public() endpoints accept unlimited attempts — credential stuffing,
// password/TOTP brute-force, and a bcrypt-per-attempt CPU DoS amplifier.
//
// Scope: per-process, fixed-window, keyed on client IP + route. This is a
// deliberately dependency-free guard (no @nestjs/throttler). For a multi-
// instance deployment behind a load balancer, move to a shared store (Redis)
// so the window is global rather than per-pod — see RATE_LIMIT note in README.

export interface RateLimitOptions {
  limit: number;       // max requests per window
  windowMs: number;    // window length in ms
}

export const RATE_LIMIT_KEY = 'rate_limit';
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts);

interface Counter { count: number; resetAt: number; }

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly hits = new Map<string, Counter>();
  private lastSweep = 0;

  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY, [ctx.getHandler(), ctx.getClass()],
    );
    if (!opts) return true; // not a rate-limited route

    const req = ctx.switchToHttp().getRequest<Request>();
    const now = Date.now();
    this.sweep(now);

    const key = `${this.clientIp(req)}:${req.method}:${req.route?.path ?? req.path}`;
    const c = this.hits.get(key);
    if (!c || c.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      return true;
    }
    if (c.count >= opts.limit) {
      const retryAfter = Math.ceil((c.resetAt - now) / 1000);
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: 'too many attempts, please try again later', retryAfter },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    c.count += 1;
    return true;
  }

  // Trust the left-most X-Forwarded-For hop when present (the app sits behind
  // a reverse proxy in the reference deployment), else the socket address.
  private clientIp(req: Request): string {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  // Periodically drop expired counters so the map can't grow unbounded.
  private sweep(now: number) {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, c] of this.hits) {
      if (c.resetAt <= now) this.hits.delete(k);
    }
  }
}
