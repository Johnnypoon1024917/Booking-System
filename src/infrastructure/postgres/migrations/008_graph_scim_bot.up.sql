-- Migration 008: Graph change-notifications subscriptions, SCIM 2.0
-- service tokens, and Bot Framework conversation state.

-- ============================================================================
-- 1. Microsoft Graph change-notification subscriptions
--   One row per (tenant, mailbox). Microsoft Graph subscriptions expire
--   after at most 4230 minutes (~ 70.5h) and must be renewed before then.
-- ============================================================================
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  mailbox_upn          TEXT NOT NULL,
  graph_subscription_id TEXT NOT NULL,             -- Microsoft's id (UUID)
  client_state         TEXT NOT NULL,              -- HMAC secret for validating notifications
  expires_at           TIMESTAMPTZ NOT NULL,
  last_renewed_at      TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mailbox_upn)
);
CREATE INDEX IF NOT EXISTS idx_graph_subs_expiry ON graph_subscriptions(expires_at);

ALTER TABLE graph_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS graph_subscriptions_tenant_isolation ON graph_subscriptions;
CREATE POLICY graph_subscriptions_tenant_isolation ON graph_subscriptions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 2. SCIM 2.0 service tokens
--   Each token is a per-tenant bearer that Azure AD (or any SCIM client)
--   uses to push user provisioning. The plaintext is shown once at issue
--   time; only the SHA-256 is stored.
-- ============================================================================
CREATE TABLE IF NOT EXISTS scim_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL,                       -- hex(sha256(plaintext))
  prefix      TEXT NOT NULL,                       -- first 8 chars for "scim_<prefix>" identification in logs
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scim_tokens_hash ON scim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_scim_tokens_tenant ON scim_tokens(tenant_id);


-- ============================================================================
-- 3. Bot conversation state
--   Per-conversation memory for the Teams bot dialog. Keyed by Bot
--   Framework's conversationId. Small JSON blob, used to track dialog
--   step ("awaiting room choice", "awaiting time", etc.).
-- ============================================================================
CREATE TABLE IF NOT EXISTS bot_conversations (
  conversation_id TEXT PRIMARY KEY,
  tenant_id       UUID,
  channel_id      TEXT,
  user_aad_id     TEXT,
  state           JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_conversations_user ON bot_conversations(user_aad_id);


-- ============================================================================
-- 4. SCIM external-id index on users so PUT/PATCH can find them by AD oid
-- ============================================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS external_id TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS idx_users_external_id ON users(tenant_id, external_id);
