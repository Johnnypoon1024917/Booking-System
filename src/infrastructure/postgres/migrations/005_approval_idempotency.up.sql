-- Migration 005: approval workflow audit trail + idempotency keys.

-- ============================================================================
-- 1. Approval audit trail
--   Each approval / rejection is recorded as a row, even after the booking
--   moves on. Useful for compliance audits and "who approved this".
-- ============================================================================
CREATE TABLE IF NOT EXISTS approvals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  approver_id UUID,                              -- nullable for system actions
  decision    TEXT NOT NULL,                     -- 'approved' | 'rejected'
  reason      TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approvals_booking ON approvals(booking_id);
CREATE INDEX IF NOT EXISTS idx_approvals_tenant ON approvals(tenant_id, decided_at DESC);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvals_tenant_isolation ON approvals;
CREATE POLICY approvals_tenant_isolation ON approvals
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 2. Idempotency keys
--   Clients send `Idempotency-Key: <uuid>` on POSTs. The middleware caches
--   the response body for 24h so a retry returns the original result.
-- ============================================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key            TEXT PRIMARY KEY,
  tenant_id      UUID,                           -- nullable: pre-tenant-context endpoints
  user_id        TEXT,
  request_path   TEXT NOT NULL,
  response_code  INT NOT NULL,
  response_body  BYTEA NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);


-- ============================================================================
-- 3. Booking lifecycle: extend status enum-ish CHECK to include 'Cancelled'.
--   The existing EXCLUDE constraint filters by status IN (...) so cancelling
--   a booking automatically frees up its time slot.
-- ============================================================================
-- (No constraint change needed — bookings.status is plain TEXT in 001.)
