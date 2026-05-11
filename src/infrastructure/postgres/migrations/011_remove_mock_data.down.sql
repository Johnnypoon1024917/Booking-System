-- No-op: re-seeding the removed demo rows here would lock us back into
-- the very mock-up data we just deleted. Roll back via 003/004 if you
-- need the demo data back (and revert this migration too).
SELECT 1;
