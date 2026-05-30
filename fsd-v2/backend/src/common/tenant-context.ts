import { AsyncLocalStorage } from 'async_hooks';
import { QueryRunner } from 'typeorm';

// Per-request tenant context. TenantTxInterceptor opens one transaction-bound
// QueryRunner per authenticated request and stashes it here; the patched
// DataSource.createQueryRunner (RlsService) returns this runner for every query
// in the request so they all execute on the one connection that carries the
// `app.current_tenant_id` GUC the Postgres RLS policies filter on — inside a
// single explicit transaction that commits/rolls back deterministically.
export interface TenantStore {
  queryRunner: QueryRunner;
}

export const tenantContext = new AsyncLocalStorage<TenantStore>();
