-- Migration 009: Bot proactive notification refs + SCIM Groups + Graph
-- notification audit log.

-- ============================================================================
-- 1. Bot conversation references — proactive Teams messaging
--   Captured on the user's first inbound activity. Lets us POST messages
--   back to Teams without the user initiating contact (e.g. "your booking
--   was approved").
-- ============================================================================
CREATE TABLE IF NOT EXISTS bot_conversation_refs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_aad_id     TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  service_url     TEXT NOT NULL,
  bot_id          TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  recipient_id    TEXT,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, user_aad_id)
);
CREATE INDEX IF NOT EXISTS idx_bot_conv_refs_user ON bot_conversation_refs(user_id);

ALTER TABLE bot_conversation_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bot_conversation_refs_tenant_isolation ON bot_conversation_refs;
CREATE POLICY bot_conversation_refs_tenant_isolation ON bot_conversation_refs
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 2. SCIM Groups — Azure AD groups → app role mapping
--   When SCIM provisioning creates a group, we map it to one of our 5
--   built-in roles. Group membership then drives the user's role.
-- ============================================================================
CREATE TABLE IF NOT EXISTS scim_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_id  TEXT,
  display_name TEXT NOT NULL,
  role         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_scim_groups_tenant ON scim_groups(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_groups_ext ON scim_groups(tenant_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE scim_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scim_groups_tenant_isolation ON scim_groups;
CREATE POLICY scim_groups_tenant_isolation ON scim_groups
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

CREATE TABLE IF NOT EXISTS scim_group_members (
  group_id   UUID NOT NULL REFERENCES scim_groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_scim_group_members_user ON scim_group_members(user_id);


-- ============================================================================
-- 3. Graph notification audit
--   Lets ops verify what notifications Microsoft sent us, and gives a
--   place to debug when reconciliation is missing rows.
-- ============================================================================
CREATE TABLE IF NOT EXISTS graph_notification_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL,
  change_type     TEXT NOT NULL,
  resource        TEXT NOT NULL,
  graph_event_id  TEXT,
  validation_ok   BOOLEAN NOT NULL DEFAULT FALSE,
  client_state_ok BOOLEAN NOT NULL DEFAULT FALSE,
  reconcile_err   TEXT,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_graph_notif_log_tenant ON graph_notification_log(tenant_id, received_at DESC);

ALTER TABLE graph_notification_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS graph_notification_log_tenant_isolation ON graph_notification_log;
CREATE POLICY graph_notification_log_tenant_isolation ON graph_notification_log
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
