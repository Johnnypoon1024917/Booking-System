DROP INDEX IF EXISTS idx_webauthn_challenges_expiry;
DROP TABLE IF EXISTS webauthn_challenges;

DROP POLICY IF EXISTS service_role_full_access ON webauthn_credentials;
DROP POLICY IF EXISTS tenant_isolation ON webauthn_credentials;
ALTER TABLE webauthn_credentials DISABLE ROW LEVEL SECURITY;
DROP INDEX IF EXISTS idx_webauthn_user;
DROP TABLE IF EXISTS webauthn_credentials;
