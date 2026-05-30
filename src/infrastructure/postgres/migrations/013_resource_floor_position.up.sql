-- Migration 013: floor-plan coordinates for resources.
--
-- Adds floor_x / floor_y columns so the admin floor-plan view can place each
-- resource on a background image at an admin-chosen position. Values are
-- stored as percentages of the container (0..100) so they remain correct
-- regardless of the displayed image size — this matches how the SPA reads
-- them with `left: floor_x%; top: floor_y%`.
--
-- A NULL value would be ambiguous (centre? unset?), so we default to 0 and
-- let the UI treat (0,0) as "not yet placed" if needed. Existing rows get
-- 0/0 on migration and admins can move them with the resource editor.

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS floor_x DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS floor_y DOUBLE PRECISION NOT NULL DEFAULT 0;

ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_floor_x_range;
ALTER TABLE resources
  ADD CONSTRAINT resources_floor_x_range CHECK (floor_x BETWEEN 0 AND 100);

ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_floor_y_range;
ALTER TABLE resources
  ADD CONSTRAINT resources_floor_y_range CHECK (floor_y BETWEEN 0 AND 100);
