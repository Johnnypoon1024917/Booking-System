-- Migration 033: tighten RLS on user_departments with WITH CHECK.
--
-- Migration 032 only set USING — that filters SELECT/DELETE but lets
-- INSERT/UPDATE write a row with any tenant_id, including a different
-- tenant's. Adding WITH CHECK closes the write side so the policy
-- rejects any attempt to insert/update a row whose tenant_id doesn't
-- match the current session's app.current_tenant_id GUC.
--
-- Paired with handler-side validation that the supplied department_id
-- actually belongs to the caller's tenant, this prevents cross-tenant
-- department-membership injection.

DROP POLICY IF EXISTS user_departments_tenant_isolation ON user_departments;
CREATE POLICY user_departments_tenant_isolation ON user_departments
  USING      (tenant_id::text = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id::text = current_setting('app.current_tenant_id', true));
