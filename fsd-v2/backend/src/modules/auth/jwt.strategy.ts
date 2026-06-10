import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, JwtFromRequestFunction, Strategy } from 'passport-jwt';
import type { Request } from 'express';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../common/decorators/roles.decorator';

// Only honor a `?token=` query parameter on the SSE stream route (AUD-010).
// Browser EventSource can't set an Authorization header, so the realtime stream
// must accept the token in the URL — but query strings leak into access logs,
// proxy logs, browser history and Referer headers, so we must NOT accept them
// for ordinary API routes. This extractor returns the query token only when the
// request targets the realtime endpoint.
const sseQueryTokenExtractor: JwtFromRequestFunction = (req: Request) => {
  const path = req?.path || (req as any)?.url || '';
  if (typeof path === 'string' && /\/realtime\/?($|\?)/.test(path)) {
    const token = (req.query?.token ?? '') as string;
    return token || null;
  }
  return null;
};

interface JwtPayload {
  sub: string;       // user id
  tid: string;       // tenant id
  username: string;
  role: Role;
  grade?: string;
  regions?: string[];
  // Intermediate, single-purpose tokens (issued by AuthService before the
  // second factor / forced password change completes) carry a `purpose` claim.
  // They are signed with the same secret as full session tokens, so this
  // strategy MUST reject them — otherwise the pre-MFA mfaToken would itself be a
  // valid session, bypassing the second factor entirely.
  purpose?: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      // Fail loud at boot rather than at first request.
      throw new Error('JWT_SECRET must be set to a 32+ character value');
    }
    super({
      // The Authorization header is the primary source. The realtime SSE stream
      // is consumed via the browser EventSource API, which cannot set custom
      // headers, so the SPA passes the JWT as a `?token=` query param (see
      // useRealtime.ts). The query fallback is scoped to the SSE route ONLY
      // (sseQueryTokenExtractor) so tokens don't leak via the URL on other
      // routes (AUD-010).
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        sseQueryTokenExtractor,
      ]),
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  // Passport calls this for every validated token. The returned object
  // becomes req.user — keep its shape stable; the AuthUser interface
  // is the contract every controller depends on.
  validate(payload: JwtPayload): AuthUser {
    if (!payload?.sub || !payload?.tid) throw new UnauthorizedException('malformed token');
    // Reject single-purpose intermediate tokens (mfa / pwd_change): they are only
    // valid at their dedicated endpoint, which checks `purpose` explicitly. A
    // full session token never carries this claim.
    if (payload.purpose) throw new UnauthorizedException('this token cannot be used for general access');
    return {
      id: payload.sub,
      tenantId: payload.tid,
      username: payload.username,
      role: payload.role,
      grade: payload.grade,
      regionAccess: payload.regions,
    };
  }
}
