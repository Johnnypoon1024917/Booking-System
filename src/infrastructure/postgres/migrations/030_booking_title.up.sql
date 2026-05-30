-- 030_booking_title.up.sql
--
-- Adds a `title` column to bookings. The SPA's BookingModal has always
-- collected "title" (e.g. "Daily Standup") but the API silently dropped
-- it, so the calendar fell back to rendering every block as "Reserved".
-- Storing the title lets the admin / week-view calendars surface the
-- actual meeting name the way Outlook / Teams / Google Calendar do.
--
-- The column is nullable + has no length cap because tenants set their
-- own conventions; common labels are 20–60 chars. Old rows stay NULL
-- and fall back to the legacy "Reserved" label client-side.

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS title TEXT;

-- Walk-in detection benefits from a composite index over (created_at,
-- start_time). The dashboard's Walk-in % is COUNT FILTER (...) where
-- start_time - created_at is below a small threshold; planning that
-- filter as an index range avoids a full scan on big datasets.
CREATE INDEX IF NOT EXISTS idx_bookings_walkin
    ON bookings(tenant_id, created_at)
    INCLUDE (start_time);
