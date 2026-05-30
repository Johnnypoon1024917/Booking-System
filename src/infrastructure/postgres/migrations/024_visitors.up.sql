-- 024_visitors.up.sql
--
-- Visitor management (Envoy-class feature).
--
-- A visit is pre-registered by a host (an MRBS user) for a specific
-- booking. On arrival, reception or a kiosk redeems the visit's
-- short-lived QR token; on departure the same flow closes the visit.
-- Health declarations and NDA acknowledgements ride along as JSONB.
--
-- The schema deliberately keeps PII (full name, email, phone, ID type)
-- in plain columns rather than encrypted JSON: it's needed for the
-- reception lookup screen, and gov-grade callers will run pgcrypto
-- column-level encryption at the database tier instead.

CREATE TABLE IF NOT EXISTS visits (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    booking_id      UUID,                      -- optional: tied to a booking
    host_user_id    UUID NOT NULL,             -- MRBS user who is hosting
    visitor_name    TEXT NOT NULL,
    visitor_email   TEXT,
    visitor_phone   TEXT,
    visitor_company TEXT,
    visitor_id_type TEXT,                      -- 'HKID' | 'Passport' | 'Other'
    visitor_id_last4 TEXT,                     -- never store the full id; last 4 only
    purpose         TEXT,
    expected_at     TIMESTAMPTZ NOT NULL,
    expected_until  TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'Expected',
                       -- 'Expected' | 'Checked In' | 'Checked Out' | 'No Show' | 'Cancelled'
    checked_in_at   TIMESTAMPTZ,
    checked_out_at  TIMESTAMPTZ,
    health_declaration JSONB,                  -- {fever:false, recentTravel:false, ...}
    nda_accepted    BOOLEAN NOT NULL DEFAULT FALSE,
    notes           TEXT,
    token_hash      TEXT,                      -- sha256 of the QR-code one-shot token
    token_expires_at TIMESTAMPTZ,
    created_by      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visits_tenant_expected ON visits(tenant_id, expected_at);
CREATE INDEX IF NOT EXISTS idx_visits_host            ON visits(host_user_id, expected_at DESC);
CREATE INDEX IF NOT EXISTS idx_visits_status          ON visits(status, expected_at);
CREATE INDEX IF NOT EXISTS idx_visits_token_hash      ON visits(token_hash) WHERE token_hash IS NOT NULL;
