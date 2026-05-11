-- ============================================================================
-- FSD-MRBS Initial Schema Migration (Down)
-- ============================================================================
-- This migration reverses the initial schema setup, removing all tables,
-- indexes, RLS policies, and extensions.
-- ============================================================================

-- ============================================================================
-- DROP ROW-LEVEL SECURITY POLICIES
-- ============================================================================

DROP POLICY IF EXISTS tenant_isolation_bookings ON bookings;
DROP POLICY IF EXISTS tenant_isolation_resources ON resources;
DROP POLICY IF EXISTS tenant_isolation_users ON users;
DROP POLICY IF EXISTS tenant_isolation_holidays ON holidays;
DROP POLICY IF EXISTS tenant_isolation_audit ON audit_entries;
DROP POLICY IF EXISTS tenant_isolation_recurring_series ON recurring_series;
DROP POLICY IF EXISTS tenant_isolation_broadcasts ON broadcasts;
DROP POLICY IF EXISTS tenant_isolation_meeting_redirects ON meeting_redirects;
DROP POLICY IF EXISTS tenant_isolation_role_configs ON role_configs;
DROP POLICY IF EXISTS tenant_isolation_notification_templates ON notification_templates;
DROP POLICY IF EXISTS tenant_isolation_weekend_configs ON weekend_configs;

-- ============================================================================
-- DISABLE ROW-LEVEL SECURITY
-- ============================================================================

ALTER TABLE bookings DISABLE ROW LEVEL SECURITY;
ALTER TABLE resources DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE holidays DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_series DISABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts DISABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_redirects DISABLE ROW LEVEL SECURITY;
ALTER TABLE role_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE notification_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE weekend_configs DISABLE ROW LEVEL SECURITY;

-- ============================================================================
-- DROP TRIGGERS
-- ============================================================================

DROP TRIGGER IF EXISTS update_tenants_updated_at ON tenants;
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP TRIGGER IF EXISTS update_resources_updated_at ON resources;
DROP TRIGGER IF EXISTS update_bookings_updated_at ON bookings;

-- ============================================================================
-- DROP FUNCTIONS
-- ============================================================================

DROP FUNCTION IF EXISTS update_updated_at_column();

-- ============================================================================
-- DROP TABLES (in reverse dependency order)
-- ============================================================================

-- Drop tables that reference other tables first
DROP TABLE IF EXISTS weekend_configs;
DROP TABLE IF EXISTS notification_templates;
DROP TABLE IF EXISTS role_configs;
DROP TABLE IF EXISTS broadcasts;
DROP TABLE IF EXISTS meeting_redirects;
DROP TABLE IF EXISTS audit_entries;
DROP TABLE IF EXISTS holidays;
DROP TABLE IF EXISTS bookings;
DROP TABLE IF EXISTS recurring_series;
DROP TABLE IF EXISTS resources;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;

-- ============================================================================
-- DROP EXTENSION (optional - uncomment if needed)
-- ============================================================================

-- DROP EXTENSION IF EXISTS "uuid-ossp";
