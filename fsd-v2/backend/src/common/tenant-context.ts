import { AsyncLocalStorage } from 'async_hooks';
import { QueryRunner } from 'typeorm';

// Per-request tenant context. The RLS interceptor pins a dedicated DB
// connection (QueryRunner) for the request and stashes it here; the patched
// DataSource.createQueryRunner (see RlsService) returns this pinned runner for
// every query in the request, so they all execute on the one connection that
// carries the `app.current_tenant_id` GUC the Postgres RLS policies filter on.
export interface TenantStore {
  queryRunner: QueryRunner;
  tenantId: string;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();
