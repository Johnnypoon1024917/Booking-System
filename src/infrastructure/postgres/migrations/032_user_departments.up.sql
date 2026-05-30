-- Migration 032: user → departments many-to-many.
--
-- A user can now belong to multiple departments. The previous model had
-- departments owned by *resources* (resources.department_id) but no
-- user-side membership, so admins couldn't say "Alice is in Operations
-- and Compliance". Join table — not a column on users — because the
-- membership is many-to-many and we need cascade behaviour: deleting a
-- department should drop the membership row, not null out a column.

CREATE TABLE IF NOT EXISTS user_departments (
  user_id       UUID NOT NULL REFERENCES users(id)        ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id)  ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id)      ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, department_id)
);

CREATE INDEX IF NOT EXISTS idx_user_departments_user   ON user_departments(user_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_dept   ON user_departments(department_id);
CREATE INDEX IF NOT EXISTS idx_user_departments_tenant ON user_departments(tenant_id);

ALTER TABLE user_departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_departments_tenant_isolation ON user_departments;
CREATE POLICY user_departments_tenant_isolation ON user_departments
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
