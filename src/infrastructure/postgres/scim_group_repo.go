package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// SCIMGroup is the persisted form of an Azure AD group that has been
// synchronized into our system. The Role column is what makes a group
// useful — adding a user to a group implicitly grants them that role.
type SCIMGroup struct {
	ID          string
	TenantID    string
	ExternalID  string
	DisplayName string
	Role        string
	Members     []string // user IDs
}

type SCIMGroupRepo struct{ db *pgxpool.Pool }

func NewSCIMGroupRepo(db *pgxpool.Pool) *SCIMGroupRepo { return &SCIMGroupRepo{db: db} }

func (r *SCIMGroupRepo) List(ctx context.Context, tenantID string) ([]SCIMGroup, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, tenant_id::text, COALESCE(external_id,''), display_name, COALESCE(role,'')
FROM scim_groups WHERE tenant_id = $1 ORDER BY display_name`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SCIMGroup
	for rows.Next() {
		var g SCIMGroup
		if err := rows.Scan(&g.ID, &g.TenantID, &g.ExternalID, &g.DisplayName, &g.Role); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, nil
}

func (r *SCIMGroupRepo) Get(ctx context.Context, id string) (*SCIMGroup, error) {
	var g SCIMGroup
	err := r.db.QueryRow(ctx, `
SELECT id, tenant_id::text, COALESCE(external_id,''), display_name, COALESCE(role,'')
FROM scim_groups WHERE id = $1`, id,
	).Scan(&g.ID, &g.TenantID, &g.ExternalID, &g.DisplayName, &g.Role)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	mems, err := r.members(ctx, id)
	if err != nil {
		return nil, err
	}
	g.Members = mems
	return &g, nil
}

func (r *SCIMGroupRepo) Save(ctx context.Context, g SCIMGroup) (string, error) {
	if g.ID == "" {
		err := r.db.QueryRow(ctx, `
INSERT INTO scim_groups (tenant_id, external_id, display_name, role)
VALUES ($1, NULLIF($2,''), $3, NULLIF($4,''))
RETURNING id`,
			g.TenantID, g.ExternalID, g.DisplayName, g.Role,
		).Scan(&g.ID)
		return g.ID, err
	}
	_, err := r.db.Exec(ctx, `
UPDATE scim_groups
   SET external_id = NULLIF($2,''),
       display_name = $3,
       role = NULLIF($4,''),
       updated_at = NOW()
 WHERE id = $1`, g.ID, g.ExternalID, g.DisplayName, g.Role)
	return g.ID, err
}

func (r *SCIMGroupRepo) Delete(ctx context.Context, id string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM scim_groups WHERE id = $1`, id)
	return err
}

// AddMember adds a user to a group; idempotent.
func (r *SCIMGroupRepo) AddMember(ctx context.Context, groupID, userID string) error {
	_, err := r.db.Exec(ctx,
		`INSERT INTO scim_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		groupID, userID)
	return err
}

func (r *SCIMGroupRepo) RemoveMember(ctx context.Context, groupID, userID string) error {
	_, err := r.db.Exec(ctx,
		`DELETE FROM scim_group_members WHERE group_id = $1 AND user_id = $2`,
		groupID, userID)
	return err
}

func (r *SCIMGroupRepo) members(ctx context.Context, groupID string) ([]string, error) {
	rows, err := r.db.Query(ctx,
		`SELECT user_id::text FROM scim_group_members WHERE group_id = $1`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}
