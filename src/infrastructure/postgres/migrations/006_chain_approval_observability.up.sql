-- Migration 006: conditional multi-level approval chains, webhook delivery
-- audit log, and per-tenant configurable approver hooks.

-- ============================================================================
-- 1. Approval rules
--   A rule is "if a booking matches this scope, route it through these
--   levels in this order". Rules are tenant-scoped and ordered by priority
--   so the first matching rule wins. A rule with NULL scope_value is the
--   tenant-wide default.
--
--   `levels` is JSONB so we don't have to schema-change every time a
--   customer adds a new level type. Shape:
--     [
--       { "name":"Department head", "approver_user_ids":["..."], "approver_role":"Room Admin",
--         "min_grade":"DGFS", "auto_after_hours": 24 },
--       { "name":"Security",        "approver_role":"Security Admin" }
--     ]
-- ============================================================================
CREATE TABLE IF NOT EXISTS approval_rules (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  scope_type    TEXT NOT NULL,           -- 'asset_type' | 'resource' | 'department' | 'tenant'
  scope_value   TEXT,                    -- e.g. 'Top Management' or a uuid; NULL for tenant-wide
  priority      INT NOT NULL DEFAULT 100,
  levels        JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approval_rules_tenant_priority
  ON approval_rules(tenant_id, priority);

ALTER TABLE approval_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_rules_tenant_isolation ON approval_rules;
CREATE POLICY approval_rules_tenant_isolation ON approval_rules
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 2. Approval steps — concrete per-booking instances
--   When a booking is created against a matching rule, we materialize one
--   row per level. Each step starts as 'pending', transitions to 'approved'
--   or 'rejected' when one of its approvers acts. The booking flips to
--   Confirmed only when ALL steps are 'approved'.
-- ============================================================================
CREATE TABLE IF NOT EXISTS approval_steps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id    UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  rule_id       UUID REFERENCES approval_rules(id) ON DELETE SET NULL,
  step_index    INT NOT NULL,                  -- 0-based ordinal in the chain
  level_name    TEXT NOT NULL,
  approver_ids  UUID[] NOT NULL DEFAULT '{}',
  approver_role TEXT,
  min_grade     TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'approved'|'rejected'|'skipped'
  decided_by    UUID,
  decision_at   TIMESTAMPTZ,
  reason        TEXT,
  due_at        TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, step_index)
);
CREATE INDEX IF NOT EXISTS idx_approval_steps_pending
  ON approval_steps(tenant_id, status) WHERE status = 'pending';

ALTER TABLE approval_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approval_steps_tenant_isolation ON approval_steps;
CREATE POLICY approval_steps_tenant_isolation ON approval_steps
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 3. Webhook delivery audit
--   Every dispatch attempt is recorded. Successful deliveries get
--   `delivered_at` set; failed ones increment `attempt_count` and the
--   dispatcher retries with exponential backoff up to 5 times. After 5
--   failures the row is parked (visible in the admin UI for retry / inspect).
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id UUID NOT NULL REFERENCES webhook_subscriptions(id) ON DELETE CASCADE,
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  attempt_count   INT NOT NULL DEFAULT 0,
  last_status     INT,
  last_error      TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_pending
  ON webhook_deliveries(next_attempt_at) WHERE delivered_at IS NULL AND attempt_count < 5;

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS webhook_deliveries_tenant_isolation ON webhook_deliveries;
CREATE POLICY webhook_deliveries_tenant_isolation ON webhook_deliveries
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 4. Seed: a default approval rule for the FSD tenant — Top Management
--   bookings need a 2-step chain (Secretary → Security Admin).
-- ============================================================================
INSERT INTO approval_rules (id, tenant_id, name, scope_type, scope_value, priority, levels)
VALUES (
  'c0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'Top Management — 2-step',
  'asset_type',
  'Top Management',
  10,
  '[
    {"name":"Secretary review","approver_role":"Secretary","min_grade":"SDO","auto_after_hours":48},
    {"name":"Security sign-off","approver_role":"Security Admin"}
  ]'::jsonb
)
ON CONFLICT (id) DO NOTHING;
