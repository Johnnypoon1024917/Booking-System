import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DataSource, QueryRunner } from 'typeorm';
import { Observable } from 'rxjs';
import { tenantContext } from '../tenant-context';
import { SKIP_TENANT_TX } from '../decorators/skip-tenant-tx.decorator';

// Per-request tenant transaction.
//
// For every authenticated request we open ONE explicit transaction on a
// dedicated connection, set `app.current_tenant_id` with SET LOCAL (so it is
// scoped to — and auto-cleared at the end of — that transaction), run the whole
// handler inside an AsyncLocalStorage context bound to that connection (so the
// patched DataSource.createQueryRunner routes every query onto it), and then
// COMMIT on success / ROLLBACK on error. The Postgres RLS policies filter every
// tenant table by the GUC; the explicit transaction guarantees writes are
// committed deterministically (the previous session-SET + autocommit design
// could lose writes on multi-write requests when a pooled connection was
// reused mid-state).
//
// Nested `manager.transaction()` calls (e.g. the booking conflict-check + insert)
// are mapped onto SAVEPOINTs, since a real nested BEGIN would throw.
//
// Streaming endpoints (SSE) opt out via @SkipTenantTx() — they must not hold a
// transaction (and a pooled connection) open for the lifetime of the stream.
@Injectable()
export class TenantTxInterceptor implements NestInterceptor {
  constructor(
    private readonly dataSource: DataSource,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const req = context.switchToHttp().getRequest();
    const tenantId: string | undefined = req.user?.tenantId;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_TENANT_TX, [
      context.getHandler(), context.getClass(),
    ]);
    if (!tenantId || skip) return next.handle();

    // Created OUTSIDE the ALS context so the patched createQueryRunner hands
    // back a real pooled runner here rather than recursing into itself.
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    await qr.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);

    // Map nested transactions onto savepoints. depth=1 == the outer tx above.
    let depth = 1;
    const realCommit = qr.commitTransaction.bind(qr);
    const realRollback = qr.rollbackTransaction.bind(qr);
    const realRelease = qr.release.bind(qr);
    qr.startTransaction = async () => { await qr.query(`SAVEPOINT rls_sp_${depth}`); depth++; };
    qr.commitTransaction = async () => { depth--; await qr.query(`RELEASE SAVEPOINT rls_sp_${depth}`); };
    qr.rollbackTransaction = async () => { depth--; await qr.query(`ROLLBACK TO SAVEPOINT rls_sp_${depth}`); };
    // Inner manager.transaction() calls release() in its finally — neuter it so
    // it can't hand our pinned connection back to the pool mid-request.
    qr.release = (async () => { /* released by the interceptor below */ }) as QueryRunner['release'];

    let settled = false;
    const finish = async (commit: boolean): Promise<void> => {
      if (settled) return;
      settled = true;
      try {
        if (commit) await realCommit();
        else await realRollback();
      } finally {
        // Always return the connection to the pool. After COMMIT/ROLLBACK it
        // carries no open transaction and (SET LOCAL) no leaked GUC.
        try { await realRelease(); } catch { /* already gone */ }
      }
    };

    return new Observable((subscriber) => {
      let sub: { unsubscribe(): void } | undefined;
      let value: unknown;
      let hasValue = false;
      // Subscribe INSIDE the ALS context so the handler + all its awaited DB
      // calls observe the pinned runner.
      tenantContext.run({ queryRunner: qr, req }, () => {
        sub = next.handle().subscribe({
          next: (v) => { value = v; hasValue = true; },
          error: (err) => { void finish(false).finally(() => subscriber.error(err)); },
          complete: () => {
            // Commit BEFORE emitting the response value, and surface a commit
            // failure as an error instead of a fake success — so a failed
            // commit can never masquerade as a 2xx with lost data.
            finish(true).then(
              () => { if (hasValue) subscriber.next(value); subscriber.complete(); },
              (commitErr) => subscriber.error(commitErr),
            );
          },
        });
      });
      return () => sub?.unsubscribe();
    });
  }
}
