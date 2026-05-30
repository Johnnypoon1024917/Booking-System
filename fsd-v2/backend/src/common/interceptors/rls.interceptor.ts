import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Observable, finalize } from 'rxjs';
import { tenantContext } from '../tenant-context';

// RLS request plumbing. For every authenticated request we:
//   1. pin a dedicated DB connection (QueryRunner) for the request,
//   2. set the `app.current_tenant_id` GUC on it (session scope),
//   3. run the whole handler inside an AsyncLocalStorage context holding that
//      runner, so the patched DataSource.createQueryRunner (RlsService) routes
//      *every* query — repos, query builders, manager.transaction — onto it.
// Postgres RLS policies (fail-open when the GUC is empty) then filter every
// tenant-owned table to the caller's tenant, as a real backstop behind the
// hand-written `where: { tenantId }` clauses.
//
// The pinned runner's release() is neutered so inner `manager.transaction`
// blocks can't hand our connection back to the pool mid-request; the
// interceptor resets the GUC and performs the real release on completion.
// Unauthenticated routes (login, health, swagger) have no tenant context and
// run on the normal pool — the policies fail open for them.
@Injectable()
export class RlsInterceptor implements NestInterceptor {
  constructor(private readonly dataSource: DataSource) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    if (!tenantId) return next.handle();

    // Created OUTSIDE the ALS context, so the patched createQueryRunner hands
    // back a real pooled runner here rather than recursing into itself.
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [tenantId]);

    const realRelease = qr.release.bind(qr);
    // Inner manager.transaction() calls release() in their finally; neuter it
    // so they don't return our pinned connection to the pool prematurely.
    qr.release = (async () => { /* deferred to interceptor cleanup */ }) as typeof qr.release;

    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      try {
        // Reset the GUC before returning the connection to the pool so a later
        // request that reuses it can never inherit a stale tenant filter.
        await qr.query(`SELECT set_config('app.current_tenant_id', '', false)`);
      } catch { /* connection already broken — pool will discard it */ }
      try { await realRelease(); } catch { /* already released */ }
    };

    return new Observable((subscriber) => {
      let sub: { unsubscribe(): void } | undefined;
      // Subscribe INSIDE the ALS context so the handler and all its awaited DB
      // calls observe the pinned runner.
      tenantContext.run({ queryRunner: qr, tenantId }, () => {
        sub = next.handle().pipe(finalize(() => { void cleanup(); })).subscribe(subscriber);
      });
      return () => sub?.unsubscribe();
    });
  }
}
