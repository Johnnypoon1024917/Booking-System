ALTER TABLE floor_plans DROP CONSTRAINT IF EXISTS floor_plans_pins_is_array;
ALTER TABLE floor_plans DROP COLUMN IF EXISTS pins;
