-- 020_audit_hardening.up.sql
--
-- Hardens the audit trail for government-grade compliance (NIST AU-3 / AU-9,
-- ISO 27001 A.12.4). Adds outcome/severity/correlation fields and a per-row
-- SHA-256 hash chain so any tampering with historical entries is detectable.
--
-- The application is the only writer; we revoke UPDATE and DELETE on
-- audit_entries to prevent in-band tampering even with valid credentials.

ALTER TABLE audit_entries
    ADD COLUMN IF NOT EXISTS outcome      TEXT,       -- 'success' | 'failure' | 'denied'
    ADD COLUMN IF NOT EXISTS severity     TEXT,       -- 'info' | 'warning' | 'critical'
    ADD COLUMN IF NOT EXISTS session_id   TEXT,
    ADD COLUMN IF NOT EXISTS request_id   TEXT,
    ADD COLUMN IF NOT EXISTS prev_hash    TEXT,       -- hex(SHA-256) of previous entry's entry_hash
    ADD COLUMN IF NOT EXISTS entry_hash   TEXT;       -- hex(SHA-256) over canonical payload + prev_hash

CREATE INDEX IF NOT EXISTS idx_audit_action_type ON audit_entries(action_type);
CREATE INDEX IF NOT EXISTS idx_audit_outcome     ON audit_entries(outcome);
CREATE INDEX IF NOT EXISTS idx_audit_actor_ts    ON audit_entries(actor_user_id, timestamp DESC);

-- A trigger blocks UPDATE and DELETE on audit_entries. SUPERUSER can still
-- override, but the application role mrbs_admin cannot.
CREATE OR REPLACE FUNCTION audit_entries_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_entries_no_update ON audit_entries;
CREATE TRIGGER audit_entries_no_update
    BEFORE UPDATE ON audit_entries
    FOR EACH ROW EXECUTE FUNCTION audit_entries_immutable();

DROP TRIGGER IF EXISTS audit_entries_no_delete ON audit_entries;
CREATE TRIGGER audit_entries_no_delete
    BEFORE DELETE ON audit_entries
    FOR EACH ROW EXECUTE FUNCTION audit_entries_immutable();
