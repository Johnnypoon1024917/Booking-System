-- Migration 016: pins are per-floor-plan, not per-resource.
--
-- Original design parked (FloorX, FloorY) directly on each resource so
-- there was effectively one "global" floor plan per tenant. The moment
-- we let an admin have several plans (Floor 1, Floor 2, Annex), the
-- global pins start to misbehave: switching to a new empty plan still
-- shows the old pins, and there's no "remove this resource from this
-- plan" because the resource just has coordinates everywhere.
--
-- This migration moves pins into a JSONB column on floor_plans. The
-- shape is `[{ resource_id, x, y }, ...]`. JSONB (rather than a join
-- table) keeps two things easy:
--   1. Duplicating a plan stays a single INSERT … SELECT — pins clone
--      automatically along with the shapes payload.
--   2. The whole plan (shapes + pins) round-trips through one PUT from
--      the SPA, which is how the drawing tool already works.
--
-- The resources.floor_x / floor_y columns stay for now — backwards
-- compat for any caller still referencing them — but the SPA stops
-- writing to them after this migration.

ALTER TABLE floor_plans
  ADD COLUMN IF NOT EXISTS pins JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE floor_plans
  DROP CONSTRAINT IF EXISTS floor_plans_pins_is_array;
ALTER TABLE floor_plans
  ADD  CONSTRAINT floor_plans_pins_is_array CHECK (jsonb_typeof(pins) = 'array');

-- Backfill: take whatever pins the tenant had already placed on resources
-- (resources.floor_x/y > 0) and seed them into that tenant's default plan
-- so we don't silently wipe the admin's existing layout on upgrade.
--
-- Tenants that haven't drawn any pins yet are unaffected (the COALESCE
-- on the aggregate just leaves their default plan with an empty pins
-- array). Tenants without any floor_plans row are also unaffected — the
-- SPA seeds one on first load.
WITH placed AS (
  SELECT r.tenant_id,
         jsonb_agg(jsonb_build_object(
           'resource_id', r.id::text,
           'x', r.floor_x,
           'y', r.floor_y
         )) AS pin_blob
    FROM resources r
   WHERE COALESCE(r.floor_x, 0) > 0 OR COALESCE(r.floor_y, 0) > 0
   GROUP BY r.tenant_id
),
target AS (
  -- Prefer the default plan; fall back to the oldest plan for the tenant.
  SELECT DISTINCT ON (fp.tenant_id) fp.id, fp.tenant_id
    FROM floor_plans fp
   ORDER BY fp.tenant_id, fp.is_default DESC, fp.created_at
)
UPDATE floor_plans fp
   SET pins = placed.pin_blob
  FROM placed
  JOIN target ON target.tenant_id = placed.tenant_id
 WHERE fp.id = target.id;
