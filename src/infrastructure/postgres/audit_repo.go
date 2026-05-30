package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"fsd-mrbs/src/domain/audit"
	"fsd-mrbs/src/infrastructure/dbctx"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// auditRepo implements audit.Repository using PostgreSQL
type auditRepo struct {
	db *pgxpool.Pool
}

// NewAuditRepository creates a new audit repository instance
func NewAuditRepository(db *pgxpool.Pool) audit.Repository {
	return &auditRepo{db: db}
}

// Save creates a new audit entry and links it into the tenant-scoped hash
// chain so tampering with historical rows is detectable.
//
// Behaviour by call site:
//
//   * When a per-request transaction is attached to ctx (i.e. the caller
//     went through middleware.WithTenantTx), we join that transaction
//     INSIDE A SAVEPOINT. The audit insert commits alongside the rest
//     of the request's work when both succeed, but if the audit insert
//     fails (bad data type, constraint, RLS reject), the SAVEPOINT is
//     rolled back and the surrounding business work survives. This is
//     critical: the auditlog package promises "audit emission must not
//     affect the caller's response semantics" — before the savepoint
//     wrap, a malformed audit row would poison the parent tx and roll
//     back the booking the user just created (audit failures should
//     never destroy the action they're trying to record).
//
//   * Without a per-request tx (background workers, the auth login
//     handler before tenant context exists, the scheduler), we open
//     our own SERIALIZABLE tx — the original behaviour — so the chain
//     stays consistent even when the API isn't in the loop.
//
// The previous hash is the EntryHash of the most-recent audit row for
// the same tenant; a fresh tenant starts with the empty string.
func (r *auditRepo) Save(ctx context.Context, entry audit.AuditEntry) error {
	previousStateJSON, _ := json.Marshal(entry.PreviousState)
	newStateJSON, _ := json.Marshal(entry.NewState)

	if tx, ok := dbctx.TxFromContext(ctx); ok {
		// Reserve a SAVEPOINT so a failed audit insert doesn't taint
		// the parent transaction. pgx.Tx.Begin() implements savepoints
		// when called on an existing tx.
		sp, err := tx.Begin(ctx)
		if err != nil {
			return fmt.Errorf("audit savepoint: %w", err)
		}
		if err := r.saveOnExecutor(ctx, sp, entry, previousStateJSON, newStateJSON); err != nil {
			_ = sp.Rollback(context.Background())
			return err
		}
		return sp.Commit(ctx)
	}
	tx, err := r.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return fmt.Errorf("audit begin: %w", err)
	}
	defer tx.Rollback(context.Background())
	if err := r.saveOnExecutor(ctx, tx, entry, previousStateJSON, newStateJSON); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// saveOnExecutor performs the chain lookup + insert against any pgx.Tx,
// be it the per-request tx or one we owned ourselves. Splitting the
// transaction lifecycle from the work makes the join-existing-tx path
// trivial.
func (r *auditRepo) saveOnExecutor(ctx context.Context, tx pgx.Tx, entry audit.AuditEntry, previousStateJSON, newStateJSON []byte) error {
	var prevHash string
	err := tx.QueryRow(ctx,
		`SELECT COALESCE(entry_hash, '') FROM audit_entries
		  WHERE tenant_id = $1 AND entry_hash IS NOT NULL
		  ORDER BY timestamp DESC, id DESC LIMIT 1`,
		entry.TenantID,
	).Scan(&prevHash)
	if err != nil && !isNoRows(err) {
		return fmt.Errorf("audit prev-hash lookup: %w", err)
	}
	entry.PrevHash = prevHash
	entry.EntryHash = computeAuditHash(entry, previousStateJSON, newStateJSON)

	_, err = tx.Exec(ctx, `
		INSERT INTO audit_entries (
		    id, tenant_id, timestamp, actor_user_id, action_type,
		    target_entity, target_id, previous_state, new_state,
		    ip_address, user_agent,
		    outcome, severity, session_id, request_id, prev_hash, entry_hash
		) VALUES (
		    $1, $2, $3, NULLIF($4,'')::uuid, $5,
		    $6, $7, $8, $9,
		    $10, $11,
		    NULLIF($12,''), NULLIF($13,''), NULLIF($14,''), NULLIF($15,''), NULLIF($16,''), $17
		)`,
		entry.ID, entry.TenantID, entry.Timestamp, entry.ActorUserID, entry.ActionType,
		entry.TargetEntity, entry.TargetID, previousStateJSON, newStateJSON,
		entry.IPAddress, entry.UserAgent,
		entry.Outcome, entry.Severity, entry.SessionID, entry.RequestID,
		entry.PrevHash, entry.EntryHash,
	)
	if err != nil {
		return fmt.Errorf("failed to save audit entry: %w", err)
	}
	return nil
}

func isNoRows(err error) bool {
	return err != nil && err.Error() == pgx.ErrNoRows.Error()
}

// computeAuditHash builds a deterministic byte sequence from the entry's
// stable fields and hashes it with SHA-256. The previous hash is folded
// in so any change to a historical row breaks the chain at every later
// row, not just the tampered one.
func computeAuditHash(e audit.AuditEntry, prev, next []byte) string {
	h := sha256.New()
	// Field order is part of the contract; do not reorder without bumping
	// a chain-version column.
	for _, part := range []string{
		e.PrevHash,
		e.ID,
		e.TenantID,
		e.Timestamp.UTC().Format("2006-01-02T15:04:05.000000000Z"),
		e.ActorUserID,
		e.ActionType,
		e.TargetEntity,
		e.TargetID,
		e.IPAddress,
		e.UserAgent,
		e.Outcome,
		e.Severity,
		e.SessionID,
		e.RequestID,
	} {
		h.Write([]byte(part))
		h.Write([]byte{0x1f}) // unit-separator delimits fields
	}
	h.Write(prev)
	h.Write([]byte{0x1f})
	h.Write(next)
	return hex.EncodeToString(h.Sum(nil))
}

// FindByID retrieves an audit entry by its ID
func (r *auditRepo) FindByID(ctx context.Context, id string) (audit.AuditEntry, error) {
	query := `
		SELECT id, tenant_id, timestamp, COALESCE(actor_user_id::text,''), action_type, target_entity, target_id,
			previous_state, new_state, ip_address, user_agent
		FROM audit_entries
		WHERE id = $1
	`

	var entry audit.AuditEntry
	var previousStateJSON, newStateJSON []byte

	err := r.db.QueryRow(ctx, query, id).Scan(
		&entry.ID,
		&entry.TenantID,
		&entry.Timestamp,
		&entry.ActorUserID,
		&entry.ActionType,
		&entry.TargetEntity,
		&entry.TargetID,
		&previousStateJSON,
		&newStateJSON,
		&entry.IPAddress,
		&entry.UserAgent,
	)
	if err != nil {
		return audit.AuditEntry{}, fmt.Errorf("failed to find audit entry by id: %w", err)
	}

	// Unmarshal JSONB fields
	if len(previousStateJSON) > 0 && string(previousStateJSON) != "null" {
		json.Unmarshal(previousStateJSON, &entry.PreviousState)
	}
	if len(newStateJSON) > 0 && string(newStateJSON) != "null" {
		json.Unmarshal(newStateJSON, &entry.NewState)
	}

	return entry, nil
}

// FindByTenant retrieves audit entries for a tenant with filtering
func (r *auditRepo) FindByTenant(ctx context.Context, tenantID string, filters audit.AuditFilter) ([]audit.AuditEntry, error) {
	query := `
		SELECT id, tenant_id, timestamp, COALESCE(actor_user_id::text,''), action_type, target_entity, target_id,
			previous_state, new_state, ip_address, user_agent
		FROM audit_entries
		WHERE tenant_id = $1
	`
	args := []interface{}{tenantID}
	argCount := 1

	// Apply filters dynamically
	if filters.StartDate != nil {
		argCount++
		query += fmt.Sprintf(" AND timestamp >= $%d", argCount)
		args = append(args, *filters.StartDate)
	}
	if filters.EndDate != nil {
		argCount++
		query += fmt.Sprintf(" AND timestamp <= $%d", argCount)
		args = append(args, *filters.EndDate)
	}
	if filters.ActorUserID != "" {
		argCount++
		query += fmt.Sprintf(" AND actor_user_id = $%d", argCount)
		args = append(args, filters.ActorUserID)
	}
	if filters.ActionType != "" {
		argCount++
		query += fmt.Sprintf(" AND action_type = $%d", argCount)
		args = append(args, filters.ActionType)
	}
	if filters.TargetEntity != "" {
		argCount++
		query += fmt.Sprintf(" AND target_entity = $%d", argCount)
		args = append(args, filters.TargetEntity)
	}
	if filters.TargetID != "" {
		argCount++
		query += fmt.Sprintf(" AND target_id = $%d", argCount)
		args = append(args, filters.TargetID)
	}

	query += " ORDER BY timestamp DESC"

	if filters.Limit > 0 {
		argCount++
		query += fmt.Sprintf(" LIMIT $%d", argCount)
		args = append(args, filters.Limit)
	}
	if filters.Offset > 0 {
		argCount++
		query += fmt.Sprintf(" OFFSET $%d", argCount)
		args = append(args, filters.Offset)
	}

	rows, err := r.db.Query(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to find audit entries: %w", err)
	}
	defer rows.Close()

	var entries []audit.AuditEntry
	for rows.Next() {
		var entry audit.AuditEntry
		var previousStateJSON, newStateJSON []byte

		err := rows.Scan(
			&entry.ID,
			&entry.TenantID,
			&entry.Timestamp,
			&entry.ActorUserID,
			&entry.ActionType,
			&entry.TargetEntity,
			&entry.TargetID,
			&previousStateJSON,
			&newStateJSON,
			&entry.IPAddress,
			&entry.UserAgent,
		)
		if err != nil {
			return nil, fmt.Errorf("failed to scan audit entry: %w", err)
		}

		// Unmarshal JSONB fields
		if len(previousStateJSON) > 0 && string(previousStateJSON) != "null" {
			json.Unmarshal(previousStateJSON, &entry.PreviousState)
		}
		if len(newStateJSON) > 0 && string(newStateJSON) != "null" {
			json.Unmarshal(newStateJSON, &entry.NewState)
		}

		entries = append(entries, entry)
	}

	return entries, nil
}
