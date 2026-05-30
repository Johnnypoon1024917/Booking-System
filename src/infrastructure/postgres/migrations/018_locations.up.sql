-- Migration 018: first-class admin-managed Locations.
-- Resources reference a location by name; the Organisation Hierarchy and
-- the resource-editor Location dropdown are driven from this table.

CREATE TABLE IF NOT EXISTS locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT loc_name_not_blank CHECK (length(trim(name)) > 0),
  CONSTRAINT loc_unique_per_tenant UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_locations_tenant ON locations(tenant_id);

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS locations_tenant_isolation ON locations;
CREATE POLICY locations_tenant_isolation ON locations
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Seed managed locations from any locations already in use by resources so
-- the hierarchy isn't empty on first load after upgrade.
INSERT INTO locations (tenant_id, name)
SELECT DISTINCT r.tenant_id, r.location
  FROM resources r
 WHERE COALESCE(trim(r.location), '') <> ''
ON CONFLICT (tenant_id, name) DO NOTHING;
