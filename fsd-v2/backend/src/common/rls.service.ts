import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';
import { tenantContext } from './tenant-context';

// RlsService does two things at boot:
//
//   1. Patches DataSource.createQueryRunner so that, inside an authenticated
//      request's AsyncLocalStorage context (set by TenantTxInterceptor), every
//      query funnels onto the one transaction-bound connection that carries the
//      tenant GUC. This is the single interception point all TypeORM
//      reads/writes pass through (repos, query builders, manager.transaction).
//
//   2. Installs Postgres RLS policies on every table with a `tenant_id`
//      column. Policies are FAIL-OPEN: when the GUC is unset/empty (crons,
//      seeders, login, unauthenticated paths, SSE) they allow all rows, so
//      enabling RLS can never cause an outage; when the GUC is set they enforce
//      tenant isolation as a backstop behind the explicit `where:{tenantId}`.
//
// IMPORTANT (production): RLS is bypassed for Postgres SUPERUSERS regardless of
// FORCE, so for the policies to actually bite the application must connect as a
// NON-superuser role. The reference docker image connects as a superuser, so
// the policies install but stay inert there; point the app at a
// least-privileged role in production to activate them. The GUC routing + the
// explicit per-request transaction are always active regardless.
@Injectable()
export class RlsService implements OnApplicationBootstrap {
  private readonly log = new Logger(RlsService.name);

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  // Fail-closed by default in production (AUD-003). When fail-closed, an unset
  // tenant GUC matches NO rows instead of all rows. System/non-request contexts
  // (crons, seeders, login) that legitimately need cross-tenant access must set
  // the bypass GUC `app.rls_bypass='on'` on their connection (see withBypass),
  // or run under a role granted BYPASSRLS. Set RLS_FAIL_CLOSED=false only for
  // local development where the convenience of allow-all outweighs isolation.
  private get failClosed(): boolean {
    const v = process.env.RLS_FAIL_CLOSED;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV === 'production';
  }

  async onApplicationBootstrap() {
    this.patchCreateQueryRunner();
    if (process.env.RLS_ENABLED === 'false') {
      this.log.warn('RLS policy install skipped (RLS_ENABLED=false)');
      return;
    }
    await this.installPolicies();
  }

  // Route per-request queries onto the transaction-bound, GUC-bearing connection
  // that TenantTxInterceptor stashed in the AsyncLocalStorage context.
  private patchCreateQueryRunner() {
    const ds = this.dataSource as DataSource & { __rlsPatched?: boolean };
    if (ds.__rlsPatched) return;
    const original = ds.createQueryRunner.bind(ds);
    ds.createQueryRunner = ((mode?: 'master' | 'slave'): QueryRunner => {
      const store = tenantContext.getStore();
      if (store?.queryRunner) return store.queryRunner;
      return original(mode);
    }) as DataSource['createQueryRunner'];
    ds.__rlsPatched = true;
    this.log.log('DataSource.createQueryRunner patched for per-request tenant routing');
  }

  private async installPolicies() {
    const rows: Array<{ table_name: string }> = await this.dataSource.query(`
      SELECT DISTINCT table_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenant_id'
    `);
    const failClosed = this.failClosed;
    // The predicate shared by USING and WITH CHECK. Fail-closed: rows match only
    // when the tenant GUC equals the row's tenant_id, OR an explicit bypass GUC
    // is set for system contexts. Fail-open (legacy/dev): also match when the GUC
    // is unset/empty.
    const predicate = failClosed
      ? `(
            current_setting('app.rls_bypass', true) = 'on'
            OR tenant_id::text = current_setting('app.current_tenant_id', true)
          )`
      : `(
            current_setting('app.current_tenant_id', true) IS NULL
            OR current_setting('app.current_tenant_id', true) = ''
            OR tenant_id::text = current_setting('app.current_tenant_id', true)
          )`;
    let ok = 0;
    for (const { table_name } of rows) {
      try {
        await this.dataSource.query(`ALTER TABLE "${table_name}" ENABLE ROW LEVEL SECURITY`);
        // FORCE so the policy applies to the table owner too (synchronize
        // creates the tables as the app role).
        await this.dataSource.query(`ALTER TABLE "${table_name}" FORCE ROW LEVEL SECURITY`);
        await this.dataSource.query(`DROP POLICY IF EXISTS tenant_isolation ON "${table_name}"`);
        await this.dataSource.query(`
          CREATE POLICY tenant_isolation ON "${table_name}"
          USING ${predicate}
          WITH CHECK ${predicate}
        `);
        ok++;
      } catch (e) {
        this.log.warn(`RLS policy on "${table_name}" skipped: ${(e as Error).message}`);
      }
    }
    this.log.log(
      `RLS tenant-isolation policies ensured on ${ok}/${rows.length} tenant tables (${failClosed ? 'fail-closed' : 'fail-open'})`,
    );
    if (failClosed) {
      this.log.warn(
        'RLS is FAIL-CLOSED: ensure the app connects as a non-superuser role and that cron/seeder/system DB work sets app.rls_bypass=\'on\' (RlsService.withBypass) or runs under a BYPASSRLS role.',
      );
    }
  }

  // Run a system/non-request unit of work with RLS bypass enabled on a dedicated
  // connection. Use for crons, seeders and other legitimately cross-tenant paths
  // when RLS is fail-closed. The bypass is scoped to this transaction via
  // SET LOCAL, so it never leaks back to the pool.
  async withBypass<T>(work: (qr: QueryRunner) => Promise<T>): Promise<T> {
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      await qr.query(`SELECT set_config('app.rls_bypass', 'on', true)`);
      const out = await work(qr);
      await qr.commitTransaction();
      return out;
    } catch (e) {
      try { await qr.rollbackTransaction(); } catch { /* already rolled back */ }
      throw e;
    } finally {
      try { await qr.release(); } catch { /* already gone */ }
    }
  }
}
