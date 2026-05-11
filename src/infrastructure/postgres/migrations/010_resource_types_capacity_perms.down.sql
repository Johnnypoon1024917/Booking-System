DROP FUNCTION IF EXISTS count_overlapping_bookings(UUID, TIMESTAMP, TIMESTAMP);

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    time_range  WITH &&
  )
  WHERE (status IN ('Confirmed', 'Pending Approval', 'Checked In'));

ALTER TABLE bookings DROP COLUMN IF EXISTS booking_mode;

ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_booking_mode_chk,
  DROP COLUMN IF EXISTS booking_mode,
  DROP COLUMN IF EXISTS shared_capacity,
  DROP COLUMN IF EXISTS color,
  DROP COLUMN IF EXISTS icon;

DROP TABLE IF EXISTS permission_catalog_permissions;
DROP TABLE IF EXISTS permission_catalog_groups;
DROP TABLE IF EXISTS resource_types;
