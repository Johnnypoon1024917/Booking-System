-- 021_user_mfa.up.sql
--
-- Scaffolds TOTP-based multi-factor authentication (NIST IA-2(1)/(2)).
-- For tenants that authenticate via SAML/OIDC, MFA is enforced by the
-- IdP and these columns stay null. For directory-or-local tenants, the
-- API requires a TOTP step when mfa_enabled is true.
--
-- The secret is stored base32-encoded (the form authenticator apps emit).
-- A future migration may wrap it in pgp_sym_encrypt once pgcrypto and a
-- per-tenant key are wired through.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS mfa_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS mfa_secret     TEXT,
    ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_mfa_enabled ON users(mfa_enabled) WHERE mfa_enabled = TRUE;
