-- Migration 012: per-resource operating hours.
--
-- Until now availability was determined purely by existing bookings + tenant
-- holidays. There was no way for an admin to say "Conference Room A is only
-- bookable Mon-Fri 09:00-18:00, closed Sundays". The booking pipeline now
-- consults this table and rejects requests that fall outside the configured
-- window for the resource's weekday.
--
-- Weekday convention follows ISO/Go: 0 = Sunday … 6 = Saturday (matching
-- time.Weekday in the Go std lib).
--
-- Times are stored as wall-clock TIME values in the tenant's local
-- timezone (configured via BOOKING_TIMEZONE, default Asia/Hong_Kong).
-- Storing as TIME (not TIMESTAMPTZ) is deliberate: "09:00 every Monday"
-- is a recurring local-time concept, not a single moment in UTC, and
-- behaves correctly across DST boundaries when interpreted in the
-- tenant's zone.
--
-- When a resource has NO rows in this table, it is treated as 24/7
-- available — i.e. the legacy behaviour is preserved for existing rooms
-- until an admin opts in by saving any operating-hours configuration.

CREATE TABLE IF NOT EXISTS resource_operating_hours (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id  UUID NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  weekday      SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  open_time    TIME NOT NULL DEFAULT '09:00',
  close_time   TIME NOT NULL DEFAULT '18:00',
  is_closed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT resource_operating_hours_order CHECK (is_closed OR close_time > open_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_operating_hours_resource_weekday
  ON resource_operating_hours(resource_id, weekday);

CREATE INDEX IF NOT EXISTS idx_resource_operating_hours_resource
  ON resource_operating_hours(resource_id);

-- Inherit tenant isolation from the parent resource. We don't store
-- tenant_id directly because the parent resource already enforces it and
-- ON DELETE CASCADE keeps the rows tied to their resource's lifecycle.
ALTER TABLE resource_operating_hours ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resource_operating_hours_tenant_isolation ON resource_operating_hours;
CREATE POLICY resource_operating_hours_tenant_isolation ON resource_operating_hours
  USING (
    EXISTS (
      SELECT 1 FROM resources r
      WHERE r.id = resource_operating_hours.resource_id
        AND r.tenant_id::text = current_setting('app.current_tenant_id', true)
    )
  );
