-- 026_chargeback.up.sql
--
-- Charge-back / departmental invoicing.
--
-- Each booking can attach cost centres and services (the existing
-- booking_services table from migration 015 carries quantity + price).
-- This migration adds:
--
--   • a cost_centre column on bookings, defaulted from the user's
--     department but overridable at booking-time;
--   • an invoices table that captures one monthly rollup per
--     (tenant, cost_centre). Status moves Draft -> Issued -> Paid;
--   • a view that pre-aggregates the chargeable hours per booking
--     so the invoice generator stays simple.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS cost_centre TEXT;

CREATE INDEX IF NOT EXISTS idx_bookings_cost_centre
    ON bookings(tenant_id, cost_centre, end_time);

CREATE TABLE IF NOT EXISTS invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    cost_centre     TEXT NOT NULL,
    period_start    DATE NOT NULL,
    period_end      DATE NOT NULL,
    currency        TEXT NOT NULL DEFAULT 'HKD',
    subtotal        NUMERIC(12, 2) NOT NULL DEFAULT 0,
    tax             NUMERIC(12, 2) NOT NULL DEFAULT 0,
    total           NUMERIC(12, 2) NOT NULL DEFAULT 0,
    line_count      INT NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'Draft',  -- 'Draft' | 'Issued' | 'Paid' | 'Void'
    issued_at       TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, cost_centre, period_start)
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(tenant_id, status);
