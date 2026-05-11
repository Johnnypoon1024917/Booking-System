ALTER TABLE bookings  DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE bookings  DROP COLUMN IF EXISTS time_range;

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_parent_not_self;
ALTER TABLE resources DROP COLUMN IF EXISTS department_id;
ALTER TABLE resources DROP COLUMN IF EXISTS sub_resource_count;
ALTER TABLE resources DROP COLUMN IF EXISTS composite_mode;
ALTER TABLE resources DROP COLUMN IF EXISTS parent_resource_id;

DROP TABLE IF EXISTS departments;
DROP TABLE IF EXISTS login_attempts;
