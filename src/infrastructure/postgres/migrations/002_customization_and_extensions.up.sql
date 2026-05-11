-- Migration 002: customization, QR check-in, weather-event log, and floor plans
-- Extends the multi-tenant platform to support productized configuration per tenant.

-- ----------------------------------------------------------------------------
-- 1. Per-tenant customization JSONB column
-- ----------------------------------------------------------------------------
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS customization_config JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ----------------------------------------------------------------------------
-- 2. QR check-in tokens
--   Each booking gets a single-use QR code that resolves to /api/v1/checkin/{token}.
--   Tokens are short, opaque, and regenerated when a booking is rescheduled.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkin_tokens (
  token       TEXT PRIMARY KEY,
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_checkin_tokens_booking ON checkin_tokens(booking_id);
CREATE INDEX IF NOT EXISTS idx_checkin_tokens_tenant ON checkin_tokens(tenant_id);

ALTER TABLE checkin_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY checkin_tokens_tenant_isolation ON checkin_tokens
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ----------------------------------------------------------------------------
-- 3. Weather-warning event log
--   Records HKO signal transitions so we can audit which exception markings
--   were automated. Useful when the No-Show report is challenged.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weather_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  signal_code  TEXT NOT NULL,        -- e.g., "T8", "T10", "BLACK_RAIN"
  active_from  TIMESTAMPTZ NOT NULL,
  active_to    TIMESTAMPTZ,
  affected_bookings INT DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_weather_events_tenant_time ON weather_events(tenant_id, active_from DESC);

ALTER TABLE weather_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY weather_events_tenant_isolation ON weather_events
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ----------------------------------------------------------------------------
-- 4. Floor plans
--   SVG markup + room-id → polygon mapping. The frontend renders this and
--   colours each polygon by realtime availability.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS floor_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  region      TEXT NOT NULL,
  name        TEXT NOT NULL,
  svg_markup  TEXT NOT NULL,
  hotspots    JSONB NOT NULL DEFAULT '[]'::jsonb,
  display_order INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_floor_plans_tenant_region ON floor_plans(tenant_id, region);

ALTER TABLE floor_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY floor_plans_tenant_isolation ON floor_plans
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- ----------------------------------------------------------------------------
-- 5. Webhook subscriptions (integration extension surface)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target_url  TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT[] NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_subs_tenant ON webhook_subscriptions(tenant_id);

ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY webhook_subs_tenant_isolation ON webhook_subscriptions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
