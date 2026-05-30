-- 025_iot_sensors.up.sql
--
-- IoT sensor ingestion.
--
-- Two related tables:
--
--   sensors          one row per physical device. A shared secret per
--                    device is used to HMAC-sign every reading so the
--                    ingest endpoint cannot accept forged or replayed
--                    payloads.
--   sensor_readings  append-only stream of readings keyed by device.
--                    Indexed for "recent readings per resource".
--
-- Resource linking is many-to-one: each sensor reports for exactly one
-- resource (a room, desk, vehicle slot). A presence reading on a sensor
-- whose resource has an active booking is interpreted as "occupied".
-- No-show auto-release reads this same stream to decide whether the
-- room is empty 15 minutes into the booking.

CREATE TABLE IF NOT EXISTS sensors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    resource_id     UUID,
    device_id       TEXT NOT NULL,
    kind            TEXT NOT NULL,             -- 'presence' | 'co2' | 'temp' | 'humidity' | 'desk-occupancy'
    secret_hash     TEXT NOT NULL,             -- sha256(shared_secret)
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_seen_at    TIMESTAMPTZ,
    last_value      DOUBLE PRECISION,
    last_bool       BOOLEAN,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, device_id)
);
CREATE INDEX IF NOT EXISTS idx_sensors_resource ON sensors(resource_id);

CREATE TABLE IF NOT EXISTS sensor_readings (
    id              BIGSERIAL PRIMARY KEY,
    sensor_id       UUID NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL,
    resource_id     UUID,
    observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    bool_value      BOOLEAN,                   -- presence / desk-occupancy
    numeric_value   DOUBLE PRECISION,          -- co2 / temp / humidity
    extra           JSONB,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_readings_sensor_time ON sensor_readings(sensor_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_readings_resource_time ON sensor_readings(resource_id, observed_at DESC)
    WHERE resource_id IS NOT NULL;
