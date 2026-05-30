DROP TRIGGER IF EXISTS audit_entries_no_delete ON audit_entries;
DROP TRIGGER IF EXISTS audit_entries_no_update ON audit_entries;
DROP FUNCTION IF EXISTS audit_entries_immutable();

DROP INDEX IF EXISTS idx_audit_actor_ts;
DROP INDEX IF EXISTS idx_audit_outcome;
DROP INDEX IF EXISTS idx_audit_action_type;

ALTER TABLE audit_entries
    DROP COLUMN IF EXISTS entry_hash,
    DROP COLUMN IF EXISTS prev_hash,
    DROP COLUMN IF EXISTS request_id,
    DROP COLUMN IF EXISTS session_id,
    DROP COLUMN IF EXISTS severity,
    DROP COLUMN IF EXISTS outcome;
