DROP INDEX IF EXISTS idx_invoices_status;
DROP TABLE IF EXISTS invoices;
DROP INDEX IF EXISTS idx_bookings_cost_centre;
ALTER TABLE bookings DROP COLUMN IF EXISTS cost_centre;
