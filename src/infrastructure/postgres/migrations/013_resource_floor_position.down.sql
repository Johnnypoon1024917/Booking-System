ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_floor_x_range;
ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_floor_y_range;

ALTER TABLE resources
  DROP COLUMN IF EXISTS floor_x,
  DROP COLUMN IF EXISTS floor_y;
