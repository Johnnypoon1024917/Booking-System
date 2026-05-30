# Row-Level Security Migration Guide

The audit identified the original `SetTenantContext` as ineffective: it ran
`set_config` on the bare pool, which gave a different connection to the
next query, dropping the setting. Phase 2 introduces the proper pattern
without forcing a global refactor.

## What changed

* `infrastructure/dbctx` exposes `RunInRequestTx`, which acquires one pool
  connection, opens a transaction, calls
  `set_config('app.current_tenant_id', $1, true)`, and runs your work
  inside that transaction.
* `presentation/api/middleware.WithTenantTx(pool)` wraps any HTTP handler
  with this behaviour. RLS policies now see the tenant.
* `dbctx.ExecutorFromContext(ctx, pool)` returns either the request tx
  (when present) or the pool fallback. Repos that adopt this helper
  automatically pick up the transaction when one is attached.

## How to migrate a route

1. Wrap the route in `middleware.WithTenantTx(pool)`:

   ```go
   mux.Handle("/api/v1/bookings", tenantMW.Middleware(
       middleware.WithTenantTx(pool)(
           middleware.RequireRoleHandler(allBookerRoles, bookingH.CreateBooking),
       ),
   ))
   ```

2. In the repo, change the receiver field from `db *pgxpool.Pool` to a
   `pool *pgxpool.Pool` and call `dbctx.ExecutorFromContext(ctx, r.pool)`
   for every statement.

3. The first time you migrate a repo end-to-end, enable a sandbox RLS
   policy on the table and run the integration tests with
   `EXPECTED_RLS_ENFORCED=true`. The repo MUST keep working — RLS is a
   defence-in-depth layer, not the primary control.

## Why we did not flip the switch globally

Every existing repo already filters by `tenant_id` explicitly. The
existing predicate IS the primary tenant boundary; RLS is the second
layer. Migrating in stages lets us:

* Roll back a single route if a policy is too strict.
* Keep audit and background workers (which legitimately span tenants)
  on the pool path.
* Add unit tests as we touch each repo, raising confidence one table
  at a time.

The plan is to migrate the highest-risk tables first: `bookings`,
`approvals`, `audit_entries`, `webhook_subscriptions`, `users`.
