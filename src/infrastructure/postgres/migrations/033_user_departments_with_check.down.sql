DROP POLICY IF EXISTS user_departments_tenant_isolation ON user_departments;
CREATE POLICY user_departments_tenant_isolation ON user_departments
  USING (tenant_id::text = current_setting('app.current_tenant_id', true));
