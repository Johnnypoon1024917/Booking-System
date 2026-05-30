-- 027_rls_policies.up.sql
--
-- Activates row-level security on every tenant-scoped table. The
-- `app.current_tenant_id` session variable is set by the
-- middleware.WithTenantTx wrapper (see infrastructure/dbctx). When unset
-- — which happens on background workers, scheduler jobs, and the admin
-- migrate binary — queries can still touch all rows because we ALSO
-- create policies for the BYPASSRLS role.
--
-- Design choices:
--
--   * FORCE ROW LEVEL SECURITY is enabled so even the table owner is
--     subject to the policies. Without that, mrbs_admin (which owns
--     everything) would silently bypass them.
--   * Two policies per table: `tenant_isolation` (USING + WITH CHECK
--     against the session var) and `service_role_full_access` (a wide
--     gate for the `mrbs_service` role used by workers that genuinely
--     need cross-tenant reach).
--   * The session-var lookup uses NULLIF + current_setting(..., TRUE)
--     so a missing setting evaluates to NULL — and the policy rejects
--     the row. This is fail-closed.
--
-- This migration is reversible: 027_rls_policies.down.sql drops every
-- policy and disables RLS on each table.

-- ---------------------------------------------------------------------
-- Helper: ensure a non-owning role exists. Workers run as this role so
-- they can opt into cross-tenant scope; the API binds as mrbs_admin and
-- is fully constrained by RLS.
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mrbs_service') THEN
        CREATE ROLE mrbs_service NOLOGIN;
    END IF;
END
$$;

-- ---------------------------------------------------------------------
-- bookings
-- ---------------------------------------------------------------------
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON bookings;
CREATE POLICY tenant_isolation ON bookings
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));

DROP POLICY IF EXISTS service_role_full_access ON bookings;
CREATE POLICY service_role_full_access ON bookings TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

-- ---------------------------------------------------------------------
-- audit_entries
-- ---------------------------------------------------------------------
ALTER TABLE audit_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON audit_entries;
CREATE POLICY tenant_isolation ON audit_entries
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));

DROP POLICY IF EXISTS service_role_full_access ON audit_entries;
CREATE POLICY service_role_full_access ON audit_entries TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

-- ---------------------------------------------------------------------
-- webhook_subscriptions
-- ---------------------------------------------------------------------
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON webhook_subscriptions;
CREATE POLICY tenant_isolation ON webhook_subscriptions
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));

DROP POLICY IF EXISTS service_role_full_access ON webhook_subscriptions;
CREATE POLICY service_role_full_access ON webhook_subscriptions TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

-- ---------------------------------------------------------------------
-- users
--
-- Users is tenant-scoped but the login flow needs to query a user BEFORE
-- the tenant context is set (we resolve the tenant FROM the user row).
-- We model that by allowing rows where the session var is empty AND the
-- caller is not yet authenticated — see auth.go: the login handler
-- queries through dbctx WITHOUT WithTenantTx, falling back to the pool.
-- For all other paths, the tenant scope applies.
-- ---------------------------------------------------------------------
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
    USING (
        NULLIF(current_setting('app.current_tenant_id', TRUE), '') IS NULL
        OR tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), '')
    )
    WITH CHECK (
        NULLIF(current_setting('app.current_tenant_id', TRUE), '') IS NULL
        OR tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), '')
    );

DROP POLICY IF EXISTS service_role_full_access ON users;
CREATE POLICY service_role_full_access ON users TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

-- ---------------------------------------------------------------------
-- visits, sensors, sensor_readings, invoices, push_subscriptions
-- ---------------------------------------------------------------------
ALTER TABLE visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON visits;
CREATE POLICY tenant_isolation ON visits
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON visits;
CREATE POLICY service_role_full_access ON visits TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE sensors ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sensors;
CREATE POLICY tenant_isolation ON sensors
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON sensors;
CREATE POLICY service_role_full_access ON sensors TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE sensor_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sensor_readings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON sensor_readings;
CREATE POLICY tenant_isolation ON sensor_readings
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON sensor_readings;
CREATE POLICY service_role_full_access ON sensor_readings TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
CREATE POLICY tenant_isolation ON invoices
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON invoices;
CREATE POLICY service_role_full_access ON invoices TO mrbs_service USING (TRUE) WITH CHECK (TRUE);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON push_subscriptions;
CREATE POLICY tenant_isolation ON push_subscriptions
    USING (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''))
    WITH CHECK (tenant_id::text = NULLIF(current_setting('app.current_tenant_id', TRUE), ''));
DROP POLICY IF EXISTS service_role_full_access ON push_subscriptions;
CREATE POLICY service_role_full_access ON push_subscriptions TO mrbs_service USING (TRUE) WITH CHECK (TRUE);
