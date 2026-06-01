import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { throwError } from 'rxjs';
import { AuditService, clientIp, reqPath } from './audit.service';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

// Global audit net.
//
// The per-handler `audit.record()` calls give rich before/after diffs for the
// actions that matter most, but they only cover the controllers someone
// remembered to instrument. This interceptor guarantees that EVERY mutating
// request — and every future endpoint, automatically — leaves an audit trail,
// together with the caller, their IP/device, the HTTP status, and the
// success/denied/failure outcome.
//
// It is registered as the OUTERMOST interceptor (before TenantTxInterceptor) on
// purpose: its logging runs outside the request's tenant transaction, so the
// write happens on its own connection and survives even when the request itself
// rolls back — which is exactly the denied/failed case we most want recorded.
//
// To avoid double rows, it skips the generic entry on success when a handler
// already wrote a rich semantic one (flagged on the request by AuditService).
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  // Reads we deliberately log despite being GETs — bulk data exfiltration
  // surfaces ("who exported the report / pulled the DSAR bundle?"). Kept
  // narrow on purpose: logging every list view would bury the signal, and
  // logging reads of the audit log itself would create a self-referential
  // feedback loop on every page load.
  private static readonly SENSITIVE_READ = /\/(reports?|dsar|export)\b/i;

  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const method = String(req.method || 'GET').toUpperCase();
    const path = reqPath(req);

    // Public/unauthenticated routes (login, change-password, health) are either
    // logged explicitly with full context by the auth flow, or are noise.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(), context.getClass(),
    ]);

    const isMutation = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const isSensitiveRead = method === 'GET' && AuditInterceptor.SENSITIVE_READ.test(path);
    const shouldLog = !isPublic && (isMutation || isSensitiveRead);

    if (!shouldLog) return next.handle();

    const finish = (statusCode: number, outcome: 'success' | 'failure' | 'denied') => {
      // A handler that wrote a rich semantic entry already covered the success
      // case — don't duplicate it. Failures/denials are always logged here,
      // because the rich record (which runs after the action) never executed.
      if (outcome === 'success' && req.__richAudited) return;
      const user = req.user;
      void this.audit.write({
        tenantId: user?.tenantId,
        userId: user?.id,
        username: user?.username || 'anonymous',
        action: `${method} ${path}`,
        severity: outcome === 'success' ? 'info' : outcome === 'denied' ? 'warning' : 'critical',
        outcome,
        targetEntity: entityFromPath(path),
        targetId: req.params?.id,
        method,
        path,
        statusCode,
        ip: clientIp(req),
        userAgent: String(req.headers?.['user-agent'] ?? '').slice(0, 512),
      });
    };

    return next.handle().pipe(
      tap(() => finish(res?.statusCode ?? 200, 'success')),
      catchError((err) => {
        const status = Number(err?.status ?? err?.statusCode ?? 500);
        finish(status, status === 401 || status === 403 ? 'denied' : 'failure');
        return throwError(() => err);
      }),
    );
  }
}

// Best-effort entity label from a REST path: the segment after the API version
// prefix, e.g. /api/v1/admin/audit -> "admin", /api/v1/bookings/:id -> "bookings".
function entityFromPath(path: string): string | undefined {
  const segs = path.split('/').filter(Boolean);
  const vIdx = segs.findIndex((s) => /^v\d+$/.test(s));
  const seg = vIdx >= 0 ? segs[vIdx + 1] : segs[0];
  return seg ? seg.slice(0, 64) : undefined;
}
