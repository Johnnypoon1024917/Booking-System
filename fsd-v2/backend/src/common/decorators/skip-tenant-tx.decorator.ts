import { SetMetadata } from '@nestjs/common';

// Marks a route as exempt from the per-request tenant transaction. Use on
// long-lived / streaming endpoints (SSE) where wrapping the handler in a
// transaction would pin a pooled connection — and hold a transaction open —
// for the entire lifetime of the stream. Skipped routes run on the normal
// connection pool; their tenant scoping relies on the explicit
// `where: { tenantId }` / JWT filtering in the handler.
export const SKIP_TENANT_TX = 'skip_tenant_tx';
export const SkipTenantTx = () => SetMetadata(SKIP_TENANT_TX, true);
