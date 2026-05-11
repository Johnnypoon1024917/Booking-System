package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SCIMToken is a per-tenant bearer token Azure AD (or any SCIM provisioner)
// uses to push user lifecycle events.
type SCIMToken struct {
	ID       string
	TenantID string
	Name     string
	Prefix   string
	IsActive bool
}

type SCIMTokenRepo struct{ db *pgxpool.Pool }

func NewSCIMTokenRepo(db *pgxpool.Pool) *SCIMTokenRepo { return &SCIMTokenRepo{db: db} }

// Issue creates a new token. The plaintext secret is returned ONCE; only
// its sha256 is persisted.
func (r *SCIMTokenRepo) Issue(ctx context.Context, tenantID, name string) (plaintext string, t *SCIMToken, err error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", nil, err
	}
	plaintext = "scim_" + hex.EncodeToString(buf)
	hash := sha256Hex(plaintext)
	id := uuid.NewString()
	if _, err := r.db.Exec(ctx, `
INSERT INTO scim_tokens (id, tenant_id, name, token_hash, prefix, is_active)
VALUES ($1, $2, $3, $4, $5, TRUE)`,
		id, tenantID, name, hash, plaintext[5:13]); err != nil {
		return "", nil, err
	}
	return plaintext, &SCIMToken{ID: id, TenantID: tenantID, Name: name, Prefix: plaintext[5:13], IsActive: true}, nil
}

// Lookup returns the token row matching the supplied plaintext (or nil).
func (r *SCIMTokenRepo) Lookup(ctx context.Context, plaintext string) (*SCIMToken, error) {
	var t SCIMToken
	err := r.db.QueryRow(ctx,
		`UPDATE scim_tokens SET last_used_at = NOW()
         WHERE token_hash = $1 AND is_active = TRUE
         RETURNING id, tenant_id::text, name, prefix, is_active`,
		sha256Hex(plaintext),
	).Scan(&t.ID, &t.TenantID, &t.Name, &t.Prefix, &t.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// List returns metadata for every token belonging to a tenant. Token
// hashes are never returned.
func (r *SCIMTokenRepo) List(ctx context.Context, tenantID string) ([]SCIMToken, error) {
	rows, err := r.db.Query(ctx,
		`SELECT id, tenant_id::text, name, prefix, is_active FROM scim_tokens WHERE tenant_id = $1 ORDER BY created_at DESC`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SCIMToken
	for rows.Next() {
		var t SCIMToken
		if err := rows.Scan(&t.ID, &t.TenantID, &t.Name, &t.Prefix, &t.IsActive); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, nil
}

func (r *SCIMTokenRepo) Revoke(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `UPDATE scim_tokens SET is_active = FALSE WHERE id = $1`, id)
	return err
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
