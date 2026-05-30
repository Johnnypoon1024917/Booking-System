-- 034_local_password.up.sql
--
-- Adds app-managed local credentials so admins can create accounts with an
-- initial password (instead of relying solely on AD/LDAP/SSO), and force the
-- user to choose a new password on first login.
--
--   password_hash         bcrypt hash; NULL for directory/SSO-only accounts
--   must_change_password  set TRUE when an admin issues an initial password;
--                         cleared once the user completes the reset.
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS password_hash        TEXT,
    ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
