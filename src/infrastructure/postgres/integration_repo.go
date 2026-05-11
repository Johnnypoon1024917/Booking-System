package postgres

import (
	"context"
	"errors"
	"time"

	"fsd-mrbs/src/domain/integration"
	infraint "fsd-mrbs/src/infrastructure/integration"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// IntegrationCredentialRepo persists integration credentials with secret
// obfuscation transparent to handlers.
type IntegrationCredentialRepo struct{ db *pgxpool.Pool }

func NewIntegrationCredentialRepo(db *pgxpool.Pool) *IntegrationCredentialRepo {
	return &IntegrationCredentialRepo{db: db}
}

func (r *IntegrationCredentialRepo) List(ctx context.Context, tenantID string) ([]integration.Credential, error) {
	rows, err := r.db.Query(ctx, `
SELECT id, tenant_id, provider, COALESCE(azure_tenant_id,''), client_id, client_secret,
       scopes, is_active, last_test_at, last_test_ok, COALESCE(last_test_err,''), updated_at
FROM integration_credentials WHERE tenant_id = $1 ORDER BY provider`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []integration.Credential
	for rows.Next() {
		c, err := scanCredential(rows)
		if err != nil {
			return nil, err
		}
		// Hide actual secret values in list responses — admin sees "••••" instead.
		c.ClientSecret = ""
		out = append(out, c)
	}
	return out, nil
}

func (r *IntegrationCredentialRepo) Get(ctx context.Context, tenantID, provider string) (*integration.Credential, error) {
	row := r.db.QueryRow(ctx, `
SELECT id, tenant_id, provider, COALESCE(azure_tenant_id,''), client_id, client_secret,
       scopes, is_active, last_test_at, last_test_ok, COALESCE(last_test_err,''), updated_at
FROM integration_credentials WHERE tenant_id = $1 AND provider = $2`, tenantID, provider)
	c, err := scanCredential(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, infraint.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func (r *IntegrationCredentialRepo) Save(ctx context.Context, c integration.Credential) error {
	stored := c.ClientSecret
	if stored != "" {
		stored = infraint.Obfuscate(stored)
	}
	_, err := r.db.Exec(ctx, `
INSERT INTO integration_credentials (tenant_id, provider, azure_tenant_id, client_id, client_secret, scopes, is_active)
VALUES ($1, $2, NULLIF($3,''), $4, $5, $6, $7)
ON CONFLICT (tenant_id, provider) DO UPDATE
SET azure_tenant_id = EXCLUDED.azure_tenant_id,
    client_id       = EXCLUDED.client_id,
    client_secret   = CASE WHEN EXCLUDED.client_secret = '' THEN integration_credentials.client_secret ELSE EXCLUDED.client_secret END,
    scopes          = EXCLUDED.scopes,
    is_active       = EXCLUDED.is_active,
    updated_at      = NOW()
`, c.TenantID, c.Provider, c.AzureTenantID, c.ClientID, stored, c.Scopes, c.IsActive)
	return err
}

func (r *IntegrationCredentialRepo) Delete(ctx context.Context, tenantID, provider string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM integration_credentials WHERE tenant_id = $1 AND provider = $2`, tenantID, provider)
	return err
}

func (r *IntegrationCredentialRepo) UpdateTestResult(ctx context.Context, tenantID, provider string, ok bool, errMsg string) error {
	_, err := r.db.Exec(ctx, `
UPDATE integration_credentials
   SET last_test_at = NOW(), last_test_ok = $3, last_test_err = NULLIF($4,'')
 WHERE tenant_id = $1 AND provider = $2`, tenantID, provider, ok, errMsg)
	return err
}

func scanCredential(row interface{ Scan(...interface{}) error }) (integration.Credential, error) {
	var c integration.Credential
	var scopes []string
	var lastAt *time.Time
	var lastOK *bool
	if err := row.Scan(&c.ID, &c.TenantID, &c.Provider, &c.AzureTenantID, &c.ClientID, &c.ClientSecret,
		&scopes, &c.IsActive, &lastAt, &lastOK, &c.LastTestErr, &c.UpdatedAt); err != nil {
		return c, err
	}
	c.Scopes = scopes
	c.LastTestAt = lastAt
	c.LastTestOK = lastOK
	if c.ClientSecret != "" {
		if pt, err := infraint.Reveal(c.ClientSecret); err == nil {
			c.ClientSecret = pt
		}
	}
	return c, nil
}

// ----- Mailbox map -----------------------------------------------------------

type RoomMailboxRepo struct{ db *pgxpool.Pool }

func NewRoomMailboxRepo(db *pgxpool.Pool) *RoomMailboxRepo { return &RoomMailboxRepo{db: db} }

func (r *RoomMailboxRepo) List(ctx context.Context, tenantID string) ([]integration.RoomMailbox, error) {
	rows, err := r.db.Query(ctx,
		`SELECT resource_id, tenant_id, mailbox_upn, COALESCE(display_name,''), is_active
         FROM room_mailbox_map WHERE tenant_id = $1 ORDER BY mailbox_upn`, tenantID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []integration.RoomMailbox
	for rows.Next() {
		var m integration.RoomMailbox
		if err := rows.Scan(&m.ResourceID, &m.TenantID, &m.MailboxUPN, &m.DisplayName, &m.IsActive); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, nil
}

func (r *RoomMailboxRepo) GetByResource(ctx context.Context, resourceID string) (*integration.RoomMailbox, error) {
	var m integration.RoomMailbox
	err := r.db.QueryRow(ctx,
		`SELECT resource_id, tenant_id, mailbox_upn, COALESCE(display_name,''), is_active
         FROM room_mailbox_map WHERE resource_id = $1`, resourceID,
	).Scan(&m.ResourceID, &m.TenantID, &m.MailboxUPN, &m.DisplayName, &m.IsActive)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, infraint.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &m, nil
}

func (r *RoomMailboxRepo) Save(ctx context.Context, m integration.RoomMailbox) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO room_mailbox_map (resource_id, tenant_id, mailbox_upn, display_name, is_active)
VALUES ($1, $2, $3, NULLIF($4,''), $5)
ON CONFLICT (resource_id) DO UPDATE
SET mailbox_upn  = EXCLUDED.mailbox_upn,
    display_name = EXCLUDED.display_name,
    is_active    = EXCLUDED.is_active,
    updated_at   = NOW()
`, m.ResourceID, m.TenantID, m.MailboxUPN, m.DisplayName, m.IsActive)
	return err
}

func (r *RoomMailboxRepo) Delete(ctx context.Context, resourceID string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM room_mailbox_map WHERE resource_id = $1`, resourceID)
	return err
}

// ----- Outlook sync record ---------------------------------------------------

type OutlookSyncRepo struct{ db *pgxpool.Pool }

func NewOutlookSyncRepo(db *pgxpool.Pool) *OutlookSyncRepo { return &OutlookSyncRepo{db: db} }

func (r *OutlookSyncRepo) Get(ctx context.Context, bookingID string) (*integration.OutlookSyncRecord, error) {
	var rec integration.OutlookSyncRecord
	err := r.db.QueryRow(ctx,
		`SELECT booking_id, tenant_id, mailbox_upn, graph_id, COALESCE(ical_uid,''), synced_at
         FROM booking_outlook_events WHERE booking_id = $1`, bookingID,
	).Scan(&rec.BookingID, &rec.TenantID, &rec.MailboxUPN, &rec.GraphID, &rec.ICalUID, &rec.SyncedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, infraint.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (r *OutlookSyncRepo) Save(ctx context.Context, rec integration.OutlookSyncRecord) error {
	_, err := r.db.Exec(ctx, `
INSERT INTO booking_outlook_events (booking_id, tenant_id, mailbox_upn, graph_id, ical_uid)
VALUES ($1, $2, $3, $4, NULLIF($5,''))
ON CONFLICT (booking_id) DO UPDATE
SET mailbox_upn = EXCLUDED.mailbox_upn,
    graph_id    = EXCLUDED.graph_id,
    ical_uid    = EXCLUDED.ical_uid,
    synced_at   = NOW()
`, rec.BookingID, rec.TenantID, rec.MailboxUPN, rec.GraphID, rec.ICalUID)
	return err
}

func (r *OutlookSyncRepo) Delete(ctx context.Context, bookingID string) error {
	_, err := r.db.Exec(ctx, `DELETE FROM booking_outlook_events WHERE booking_id = $1`, bookingID)
	return err
}
