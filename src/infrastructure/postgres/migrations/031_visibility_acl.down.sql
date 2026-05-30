DROP INDEX IF EXISTS idx_bookings_private;
DROP INDEX IF EXISTS idx_resources_details_acl;
ALTER TABLE bookings DROP COLUMN IF EXISTS is_private;
ALTER TABLE resources DROP COLUMN IF EXISTS details_visible_to_role;
