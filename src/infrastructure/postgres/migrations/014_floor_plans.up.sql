-- Migration 014: server-side floor plans (admin-drawn).
--
-- Background: migration 002 reserved a `floor_plans` table for an SVG +
-- hotspot model that never shipped — nothing in the Go code reads or
-- writes it, and any tenant that has run migrations 001..013 has an
-- empty `floor_plans` table left over. This migration repurposes the
-- name for the new admin-drawn schema:
--
--   id, tenant_id, name, shapes (JSONB), is_default, timestamps
--
-- The shapes payload is JSONB because:
--   - shapes have no relations (they're pure visual elements)
--   - the drawing tool persists the whole array on every edit anyway
--   - it makes copy-and-paste a single `INSERT … SELECT shapes` op
--
-- Multiple plans per tenant are supported so an org can model e.g.
-- "Floor 1", "Floor 2", "Annex Building". One plan may be marked default.
-- Resources still own their (FloorX, FloorY) coordinates — a future
-- migration can add `resources.floor_plan_id` if we want pins scoped per
-- plan. For now pins are global per tenant, matching the v1 admin UX.
--
-- DROP-then-CREATE is safe here because (a) the legacy table is unused
-- in production code paths and (b) any rows in it would be development
-- placeholders from the unfinished SVG-hotspot feature.

DROP TABLE IF EXISTS floor_plans;

CREATE TABLE floor_plans (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  shapes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_default  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT floor_plans_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT floor_plans_shapes_is_array CHECK (jsonb_typeof(shapes) = 'array')
);

CREATE INDEX idx_floor_plans_tenant ON floor_plans(tenant_id);

-- At most one default plan per tenant. Partial unique index is the
-- idiomatic way to express this without forcing every row to have a flag.
CREATE UNIQUE INDEX idx_floor_plans_one_default_per_tenant
  ON floor_plans(tenant_id) WHERE is_default = TRUE;

-- Tenant isolation via RLS, same pattern as other admin-managed tables.
ALTER TABLE floor_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS floor_plans_tenant_isolation ON floor_plans;
CREATE POLICY floor_plans_tenant_isolation ON floor_plans
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
