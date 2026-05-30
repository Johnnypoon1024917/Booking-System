-- Drop every policy first; only then disable RLS on the tables.
-- Order matches the up migration.

DROP POLICY IF EXISTS service_role_full_access ON push_subscriptions;
DROP POLICY IF EXISTS tenant_isolation ON push_subscriptions;
ALTER TABLE push_subscriptions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON invoices;
DROP POLICY IF EXISTS tenant_isolation ON invoices;
ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON sensor_readings;
DROP POLICY IF EXISTS tenant_isolation ON sensor_readings;
ALTER TABLE sensor_readings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON sensors;
DROP POLICY IF EXISTS tenant_isolation ON sensors;
ALTER TABLE sensors DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON visits;
DROP POLICY IF EXISTS tenant_isolation ON visits;
ALTER TABLE visits DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON users;
DROP POLICY IF EXISTS tenant_isolation ON users;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON webhook_subscriptions;
DROP POLICY IF EXISTS tenant_isolation ON webhook_subscriptions;
ALTER TABLE webhook_subscriptions DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON audit_entries;
DROP POLICY IF EXISTS tenant_isolation ON audit_entries;
ALTER TABLE audit_entries DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_role_full_access ON bookings;
DROP POLICY IF EXISTS tenant_isolation ON bookings;
ALTER TABLE bookings DISABLE ROW LEVEL SECURITY;
