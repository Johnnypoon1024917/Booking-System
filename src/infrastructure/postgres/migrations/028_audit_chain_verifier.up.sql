-- 028_audit_chain_verifier.up.sql
--
-- Stored procedure that walks audit_entries per tenant and recomputes
-- each row's hash from its predecessor. Used by:
--
--   * The DR runbook after a restore — see docs/BACKUP_AND_DR.md;
--     `SELECT verify_audit_chain();` must return zero broken chains.
--   * A nightly scheduler tick (added separately) that alerts when a
--     chain breaks unexpectedly — i.e. someone bypassed the API and
--     edited audit_entries directly through psql.
--
-- The hash composition mirrors computeAuditHash in audit_repo.go: each
-- row's entry_hash is sha256(prev_hash || id || tenant_id || timestamp
-- || actor_user_id || action_type || target_entity || target_id ||
-- ip_address || user_agent || outcome || severity || session_id ||
-- request_id || previous_state || new_state). The unit separator (0x1f)
-- delimits fields exactly as the Go code emits them, so reconstructed
-- hashes byte-equal the stored ones for untampered chains.
--
-- Return shape: one row per tenant.
--   tenant_id            uuid
--   total_entries        int
--   broken_at_id         uuid   NULL on healthy chains
--   broken_at_timestamp  timestamptz
--   reason               text   one of 'ok' | 'prev_mismatch' | 'hash_mismatch'

CREATE OR REPLACE FUNCTION verify_audit_chain()
RETURNS TABLE (
    tenant_id            uuid,
    total_entries        bigint,
    broken_at_id         uuid,
    broken_at_timestamp  timestamptz,
    reason               text
)
LANGUAGE plpgsql
AS $$
DECLARE
    t_id              uuid;
    rec               record;
    expected_prev     text;
    composed          bytea;
    computed_hash     text;
    fields_seen       bigint;
    found_break       boolean;
    break_id          uuid;
    break_ts          timestamptz;
    break_reason      text;
BEGIN
    FOR t_id IN
        SELECT DISTINCT a.tenant_id FROM audit_entries a WHERE a.entry_hash IS NOT NULL
    LOOP
        expected_prev := '';
        fields_seen := 0;
        found_break := FALSE;
        break_id := NULL;
        break_ts := NULL;
        break_reason := 'ok';

        FOR rec IN
            SELECT id, audit_entries.tenant_id, timestamp,
                   COALESCE(actor_user_id::text, '')   AS actor_user_id,
                   action_type, target_entity, target_id,
                   COALESCE(ip_address, '')           AS ip_address,
                   COALESCE(user_agent, '')           AS user_agent,
                   COALESCE(outcome, '')              AS outcome,
                   COALESCE(severity, '')             AS severity,
                   COALESCE(session_id, '')           AS session_id,
                   COALESCE(request_id, '')           AS request_id,
                   COALESCE(prev_hash, '')            AS prev_hash,
                   entry_hash,
                   previous_state, new_state
            FROM audit_entries
            WHERE audit_entries.tenant_id = t_id AND entry_hash IS NOT NULL
            ORDER BY timestamp ASC, id ASC
        LOOP
            fields_seen := fields_seen + 1;

            -- 1. The stored prev_hash MUST equal the previous entry's hash.
            IF rec.prev_hash <> expected_prev THEN
                found_break := TRUE;
                break_id := rec.id;
                break_ts := rec.timestamp;
                break_reason := 'prev_mismatch';
                EXIT;
            END IF;

            -- 2. Recompute the hash from the stable fields and compare.
            --    Field order MUST match computeAuditHash in audit_repo.go.
            composed :=
                convert_to(rec.prev_hash, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.id::text, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.tenant_id::text, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(to_char(rec.timestamp AT TIME ZONE 'UTC',
                                   'YYYY-MM-DD"T"HH24:MI:SS.US000"Z"'), 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.actor_user_id, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.action_type, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.target_entity, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.target_id, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.ip_address, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.user_agent, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.outcome, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.severity, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.session_id, 'UTF8') || E'\\x1f'::bytea ||
                convert_to(rec.request_id, 'UTF8') || E'\\x1f'::bytea ||
                COALESCE(rec.previous_state::text::bytea, ''::bytea) || E'\\x1f'::bytea ||
                COALESCE(rec.new_state::text::bytea, ''::bytea);

            computed_hash := encode(digest(composed, 'sha256'), 'hex');

            IF computed_hash <> rec.entry_hash THEN
                found_break := TRUE;
                break_id := rec.id;
                break_ts := rec.timestamp;
                break_reason := 'hash_mismatch';
                EXIT;
            END IF;

            expected_prev := rec.entry_hash;
        END LOOP;

        tenant_id := t_id;
        total_entries := fields_seen;
        broken_at_id := break_id;
        broken_at_timestamp := break_ts;
        reason := break_reason;
        RETURN NEXT;
    END LOOP;

    RETURN;
END;
$$;

-- The function depends on pgcrypto for digest(). Add it now if missing.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

COMMENT ON FUNCTION verify_audit_chain() IS
'Walks audit_entries per tenant and verifies the SHA-256 hash chain. '
'Returns one row per tenant; broken_at_id is NULL when healthy. '
'See computeAuditHash in audit_repo.go for the field-order contract.';
