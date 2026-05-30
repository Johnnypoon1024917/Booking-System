-- 034_local_password.down.sql
ALTER TABLE users
    DROP COLUMN IF EXISTS password_hash,
    DROP COLUMN IF EXISTS must_change_password;
