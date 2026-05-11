-- Migration 010: admin-extensible catalogs + capacity-shared bookings.
--
-- 1. resource_types  → admin-defined asset-type catalog (Room, Vehicle, Gym,
--    Studio, Boat, Drone, …). Replaces the hard-coded enum on the resources
--    page so each tenant can model its own taxonomy.
--
-- 2. permission_catalog_groups + permission_catalog_permissions → admin-
--    extensible permission keys layered on top of the built-in catalog.
--    The built-ins are still defined in code (domain/permission/catalog.go)
--    and remain the floor; tenants can add their own keys here.
--
-- 3. resources.booking_mode + resources.shared_capacity → some resources
--    (gym, classroom, drop-in zone, parking) admit N concurrent users for
--    the same time slot. The legacy bookings_no_overlap EXCLUDE constraint
--    is replaced so it only fires for exclusive resources.
--
-- 4. resources.color, resources.icon → optional UX hints surfaced in the
--    SPA so tenants can theme their catalog.

-- ============================================================================
-- 1. Tenant-defined resource (asset) types
-- ============================================================================
CREATE TABLE IF NOT EXISTS resource_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,                     -- machine-readable, e.g. "gym"
  label       TEXT NOT NULL,                     -- "Gym room"
  icon        TEXT,                              -- lucide name or emoji
  color       TEXT,                              -- hex, optional
  default_capacity        INT  NOT NULL DEFAULT 1,
  default_booking_mode    TEXT NOT NULL DEFAULT 'exclusive',  -- 'exclusive' | 'shared'
  default_requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  display_order  INT  NOT NULL DEFAULT 100,
  is_builtin     BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_resource_types_tenant_key
  ON resource_types(tenant_id, key);

ALTER TABLE resource_types ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS resource_types_tenant_isolation ON resource_types;
CREATE POLICY resource_types_tenant_isolation ON resource_types
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Seed the built-ins for the default tenant. The application reads from
-- this table at boot, falling back to hard-coded keys when the table is
-- empty for a tenant.
INSERT INTO resource_types (tenant_id, key, label, icon, default_capacity, default_booking_mode, default_requires_approval, is_builtin, display_order)
SELECT t.id, x.key, x.label, x.icon, x.cap, x.mode, x.appr, TRUE, x.ord
FROM tenants t,
     (VALUES
       ('Room',           'Meeting room',     'door-open',       8,  'exclusive', FALSE, 10),
       ('Vehicle',        'Vehicle',          'car',             4,  'exclusive', TRUE,  20),
       ('Equipment',      'Equipment',        'wrench',          1,  'exclusive', FALSE, 30),
       ('Top Management', 'Senior management','crown',           1,  'exclusive', TRUE,  40),
       ('Gym',            'Gym / fitness',    'dumbbell',       10, 'shared',    FALSE, 50),
       ('Studio',         'Studio / classroom','users',         20, 'shared',    FALSE, 60),
       ('Parking',        'Parking bay',      'parking-circle',  1, 'exclusive', FALSE, 70)
     ) AS x(key, label, icon, cap, mode, appr, ord)
ON CONFLICT (tenant_id, key) DO NOTHING;


-- ============================================================================
-- 2. Permission catalog (extensible)
-- ============================================================================
CREATE TABLE IF NOT EXISTS permission_catalog_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,        -- e.g. "facilities"
  label        TEXT NOT NULL,        -- "Facilities management"
  display_order INT NOT NULL DEFAULT 100,
  is_builtin   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_groups_tenant_key
  ON permission_catalog_groups(tenant_id, key);

CREATE TABLE IF NOT EXISTS permission_catalog_permissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_key    TEXT NOT NULL,
  key          TEXT NOT NULL,        -- e.g. "facilities.assign_keycard"
  label        TEXT NOT NULL,
  description  TEXT,
  is_builtin   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_perm_perms_tenant_key
  ON permission_catalog_permissions(tenant_id, key);

ALTER TABLE permission_catalog_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE permission_catalog_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS perm_groups_tenant_isolation ON permission_catalog_groups;
DROP POLICY IF EXISTS perm_perms_tenant_isolation ON permission_catalog_permissions;
CREATE POLICY perm_groups_tenant_isolation ON permission_catalog_groups
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
CREATE POLICY perm_perms_tenant_isolation ON permission_catalog_permissions
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));


-- ============================================================================
-- 3. Capacity-shared booking mode
-- ============================================================================
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS booking_mode TEXT NOT NULL DEFAULT 'exclusive',
  ADD COLUMN IF NOT EXISTS shared_capacity INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS color TEXT,
  ADD COLUMN IF NOT EXISTS icon  TEXT;

ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_booking_mode_chk;
ALTER TABLE resources
  ADD CONSTRAINT resources_booking_mode_chk
  CHECK (booking_mode IN ('exclusive', 'shared'));

-- The legacy EXCLUDE constraint blocks every overlap. Re-create it so it
-- only fires for bookings flagged 'exclusive'. The application sets
-- bookings.booking_mode at insert time from the resource's mode. Shared
-- resources skip the EXCLUDE entirely and use an application-level
-- capacity check (see usecase/create_booking.go).
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_mode TEXT NOT NULL DEFAULT 'exclusive';

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    time_range  WITH &&
  )
  WHERE (
    status IN ('Confirmed', 'Pending Approval', 'Checked In')
    AND booking_mode = 'exclusive'
  );

-- Helper: count concurrent confirmed bookings for a (resource, range).
-- The booking use case calls this for shared resources and rejects when
-- the count would exceed shared_capacity.
CREATE OR REPLACE FUNCTION count_overlapping_bookings(p_resource UUID, p_start TIMESTAMP, p_end TIMESTAMP)
RETURNS INT
LANGUAGE SQL STABLE AS $$
  SELECT COUNT(*)::INT
  FROM bookings
  WHERE resource_id = p_resource
    AND status IN ('Confirmed', 'Pending Approval', 'Checked In')
    AND time_range && tsrange(p_start, p_end, '[)');
$$;
