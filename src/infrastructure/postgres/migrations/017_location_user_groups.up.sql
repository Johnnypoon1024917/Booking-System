-- Migration 017: location user groups (Room Privilege Setup by
-- Organisation Hierarchy — FSD spec p.12).
--
-- A location user group binds a set of users (resolved client-side via a
-- filter strategy) to a set of locations, with optional approver routing.
-- approvers/locations are JSONB string arrays for the same reason floor
-- plan shapes are JSONB: the SPA owns the shape and we never want a
-- migration for a new attribute.

CREATE TABLE IF NOT EXISTS location_user_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  filter_by   TEXT NOT NULL DEFAULT 'Whitelist',
  approvers   JSONB NOT NULL DEFAULT '[]'::jsonb,
  locations   JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'Active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT lug_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT lug_approvers_is_array CHECK (jsonb_typeof(approvers) = 'array'),
  CONSTRAINT lug_locations_is_array CHECK (jsonb_typeof(locations) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_location_user_groups_tenant ON location_user_groups(tenant_id);

ALTER TABLE location_user_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS location_user_groups_tenant_isolation ON location_user_groups;
CREATE POLICY location_user_groups_tenant_isolation ON location_user_groups
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
