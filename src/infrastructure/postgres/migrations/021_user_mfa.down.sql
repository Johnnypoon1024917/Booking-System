DROP INDEX IF EXISTS idx_users_mfa_enabled;

ALTER TABLE users
    DROP COLUMN IF EXISTS mfa_enrolled_at,
    DROP COLUMN IF EXISTS mfa_secret,
    DROP COLUMN IF EXISTS mfa_enabled;
