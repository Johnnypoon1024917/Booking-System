-- Migration 004: production hardening + composite/split resources +
-- admin domain (departments, login attempts).

-- ============================================================================
-- 1. Composite resources — basketball court ↔ badminton court split
-- ============================================================================
-- Resources can declare a parent. A booking on the parent blocks all
-- children (and vice versa). Siblings do not conflict with each other.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS parent_resource_id UUID REFERENCES resources(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS composite_mode VARCHAR(20),  -- 'parent' | 'child' | NULL
  ADD COLUMN IF NOT EXISTS sub_resource_count INT NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_resources_parent ON resources(parent_resource_id);

-- A resource cannot be its own parent.
ALTER TABLE resources
  DROP CONSTRAINT IF EXISTS resources_parent_not_self;
ALTER TABLE resources
  ADD CONSTRAINT resources_parent_not_self
  CHECK (parent_resource_id IS NULL OR parent_resource_id <> id);


-- ============================================================================
-- 2. Atomic booking — EXCLUDE constraint prevents same-resource overlap
-- ============================================================================
-- Without this, the application's "check then insert" is racy: two concurrent
-- requests both pass HasConflict and both INSERT. With this, the second
-- INSERT raises a constraint violation and the use case retries / errors.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- A generated column gives us a range the GIST index can operate on. We
-- use tsrange (timestamp without time zone) instead of tstzrange because
-- the bookings table stores plain `timestamp` columns; tstzrange()
-- requires a timezone conversion at expression-eval time, which Postgres
-- considers non-immutable and rejects in a generated column.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS time_range tsrange
  GENERATED ALWAYS AS (tsrange(start_time, end_time, '[)')) STORED;

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    time_range  WITH &&
  )
  WHERE (status IN ('Confirmed', 'Pending Approval', 'Checked In'));


-- ============================================================================
-- 3. Login attempts — for IP+username rate-limiting / lockout
-- ============================================================================
CREATE TABLE IF NOT EXISTS login_attempts (
  identifier    TEXT PRIMARY KEY,                -- "ip:1.2.3.4" or "user:admin"
  attempt_count INT NOT NULL DEFAULT 0,
  window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_locked ON login_attempts(locked_until);


-- ============================================================================
-- 4. Departments — for resource grouping under the admin module
-- ============================================================================
CREATE TABLE IF NOT EXISTS departments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  code        TEXT,
  parent_id   UUID REFERENCES departments(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_tenant_name ON departments(tenant_id, name);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS departments_tenant_isolation ON departments;
CREATE POLICY departments_tenant_isolation ON departments
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));

-- Resources can belong to a department for rollup reporting.
ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_resources_department ON resources(department_id);


-- (Sample resources and departments were removed; admin populates them
-- through the Tenant Studio. Existing DBs are cleaned by migration 011.)
