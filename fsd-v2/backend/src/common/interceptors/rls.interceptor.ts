import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Observable, from, switchMap, finalize, throwError, catchError, of } from 'rxjs';

// RLS plumbing: each request opens a transaction, sets the
// `app.current_tenant_id` GUC, then runs the handler with that
// transaction as the request's "scoped" EntityManager. Postgres RLS
// policies on every tenant-owned table evaluate the GUC and filter
// rows to the caller's tenant.
//
// Read paths within a request all see the same isolation snapshot;
// write paths inherit the transaction so DELETE+INSERT pairs are
// atomic (the bug we just hit in v1's admin user route is impossible
// here because the transaction wraps the whole controller invocation).
//
// Controllers/services access the per-request EntityManager via
// `@Inject(REQUEST_EM)`. Outside an authenticated request (login,
// health, swagger) there is no tx and queries go straight to the
// connection pool — same model as v1's GetByID-before-tenant path.
export const REQUEST_EM = 'REQUEST_EM';

@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) {
      // Unauthenticated route — no RLS context to set.
      return next.handle();
    }

    const qr = this.dataSource.createQueryRunner();
    return from(qr.connect()).pipe(
      switchMap(() => qr.startTransaction()),
      switchMap(() =>
        qr.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]),
      ),
      switchMap(() => {
        // Stash the tx-scoped manager on the request so services can
        // grab it without injecting RlsInterceptor everywhere.
        req[REQUEST_EM] = qr.manager;
        return next.handle();
      }),
      switchMap(async (result) => {
        await qr.commitTransaction();
        return result;
      }),
      catchError(async (err) => {
        await qr.rollbackTransaction();
        throw err;
      }),
      finalize(async () => {
        await qr.release();
      }),
      // catchError above re-throws inside an async function, which RxJS
      // wraps in a promise — surface that back as a stream error.
      switchMap((v) => (v instanceof Error ? throwError(() => v) : of(v))),
    );
  }
}

// Helper for services: pull the request-scoped manager off the request
// object. If absent (unauthenticated path) the caller should fall back
// to the default data source.
export function emFor(req: any) {
  return req?.[REQUEST_EM];
}
