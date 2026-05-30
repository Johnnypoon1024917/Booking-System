-- Migration 004: Add tables for catering & services management.
--
-- This adds a catalog of available services (e.g. "Coffee", "Projector Setup")
-- and a join table to associate selected services with a specific booking.

-- service_categories: Groups services for easier management and UI presentation.
-- e.g. "Beverages", "AV Equipment", "Admin Support"
CREATE TABLE IF NOT EXISTS service_categories (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- services: The actual items or services that can be ordered.
CREATE TABLE IF NOT EXISTS services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    category_id     UUID REFERENCES service_categories(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    description     TEXT,
    price           NUMERIC(10, 2), -- Optional: for tracking costs
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, name)
);

-- booking_services: Join table linking bookings to the services requested.
CREATE TABLE IF NOT EXISTS booking_services (
    booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    service_id      UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
    quantity        INTEGER NOT NULL DEFAULT 1,
    notes           TEXT, -- e.g. "2x milk, 1x sugar"
    PRIMARY KEY (booking_id, service_id)
);