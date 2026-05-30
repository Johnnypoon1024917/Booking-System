import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthUser } from '../../common/decorators/current-user.decorator';
import { Role } from '../../common/decorators/roles.decorator';

interface JwtPayload {
  sub: string;       // user id
  tid: string;       // tenant id
  username: string;
  role: Role;
  grade?: string;
  regions?: string[];
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
      // The Authorization header is the primary source. The realtime SSE
      // stream is consumed via the browser EventSource API, which cannot set
      // custom headers, so the SPA passes the JWT as a `?token=` query param
      // (see useRealtime.ts). Accept both — header first, query fallback —
      // otherwise every page's SSE connection 401s.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
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
