-- Migration 007: external integrations (Microsoft 365, Teams) + granular
-- per-tenant permission matrix.

-- ============================================================================
-- 1. Integration credentials
--   One row per (tenant, provider). Secrets are obfuscated at rest with a
--   simple xor + base64 (we don't have a vault yet); production deployments
--   should swap this for envelope encryption with KMS or a Vault sidecar.
-- ============================================================================
CREATE TABLE IF NOT EXISTS integration_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,            -- 'microsoft' | 'google' | 'zoom'
  azure_tenant_id TEXT,                     -- only for microsoft
  client_id       TEXT NOT NULL,
  client_secret   TEXT NOT NULL,            -- obfuscated (see infra/integration/secret.go)
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_test_at    TIMESTAMPTZ,
  last_test_ok    BOOLEAN,
  last_test_err   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, provider)
);

ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_credentials_tenant_isolation ON integration_credentials;
CREATE POLICY integration_credentials_tenant_isolation ON integration_credentials
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 2. Room mailbox map
--   Maps a bookable resource to its Outlook room mailbox UPN
--   (e.g. "boardroom.a@fsd.gov.hk"). The graph worker only syncs
--   resources that have a mapping entry.
-- ============================================================================
CREATE TABLE IF NOT EXISTS room_mailbox_map (
  resource_id   UUID PRIMARY KEY REFERENCES resources(id) ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mailbox_upn   TEXT NOT NULL,                  -- e.g. boardroom.a@fsd.gov.hk
  display_name  TEXT,
  external_id   TEXT,                           -- last-known Graph eventID for sync
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_room_mailbox_map_tenant ON room_mailbox_map(tenant_id);

ALTER TABLE room_mailbox_map ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS room_mailbox_map_tenant_isolation ON room_mailbox_map;
CREATE POLICY room_mailbox_map_tenant_isolation ON room_mailbox_map
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 3. Booking ↔ Outlook event id (so updates / cancels can find the event)
-- ============================================================================
CREATE TABLE IF NOT EXISTS booking_outlook_events (
  booking_id   UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mailbox_upn  TEXT NOT NULL,
  graph_id     TEXT NOT NULL,
  ical_uid     TEXT,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_booking_outlook_tenant ON booking_outlook_events(tenant_id);

ALTER TABLE booking_outlook_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS booking_outlook_events_tenant_isolation ON booking_outlook_events;
CREATE POLICY booking_outlook_events_tenant_isolation ON booking_outlook_events
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 4. Role permissions
--   Granular permission flags per (tenant, role). The schema is one row
--   per role with a `permissions TEXT[]` so we can add new permission
--   keys without schema migrations.
--
--   The 5 built-in roles are seeded with sane defaults below; admins can
--   override per tenant via the admin UI.
-- ============================================================================
CREATE TABLE IF NOT EXISTS role_permissions (
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role        TEXT NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, role)
);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS role_permissions_tenant_isolation ON role_permissions;
CREATE POLICY role_permissions_tenant_isolation ON role_permissions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Seed defaults for FSD tenant
INSERT INTO role_permissions (tenant_id, role, permissions) VALUES
  ('00000000-0000-0000-0000-000000000001', 'System Admin',
   ARRAY[
     'booking.create','booking.cancel','booking.cancel_others','booking.update','booking.read_all',
     'resource.create','resource.update','resource.delete','resource.split',
     'user.create','user.update','user.deactivate',
     'department.manage','holiday.manage','holiday.import',
     'approval.decide','approval.delegate','approval.bypass',
     'approval_rule.manage',
     'webhook.manage','integration.manage','permission.manage',
     'report.view','report.export','customization.manage',
     'audit.view','tenant.manage'
   ]),
  ('00000000-0000-0000-0000-000000000001', 'Security Admin',
   ARRAY[
     'booking.read_all','approval.decide','user.update','user.deactivate',
     'audit.view','report.view','permission.manage'
   ]),
  ('00000000-0000-0000-0000-000000000001', 'Room Admin',
   ARRAY[
     'booking.create','booking.cancel','booking.update',
     'resource.update','resource.split','holiday.manage','approval.decide','report.view'
   ]),
  ('00000000-0000-0000-0000-000000000001', 'Secretary',
   ARRAY[
     'booking.create','booking.cancel','booking.update',
     'approval.decide','booking.read_all'
   ]),
  ('00000000-0000-0000-0000-000000000001', 'General User',
   ARRAY['booking.create','booking.cancel','booking.update'])
ON CONFLICT (tenant_id, role) DO NOTHING;
