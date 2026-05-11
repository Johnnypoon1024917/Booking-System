// Package integration models third-party connector configuration. Each
// row is a per-(tenant, provider) credential bundle the system uses when
// pushing bookings out to that platform's calendar / messaging API.
package integration

import (
	"context"
	"time"
)

// Provider identifiers — extend as we add connectors.
const (
	ProviderMicrosoft = "microsoft"
	ProviderGoogle    = "google"
	ProviderZoom      = "zoom"
)

// Credential stores how to authenticate against a provider.
//
// ClientSecret is held in obfuscated form (see infrastructure/integration/secret.go).
// The Get/Save repo methods do the (de)obfuscation transparently so handlers
// always see plaintext while at-rest storage is opaque.
type Credential struct {
	ID            string
	TenantID      string
	Provider      string
	AzureTenantID string   // Microsoft-only
	ClientID      string
	ClientSecret  string   // plaintext after Get; obfuscated only when at-rest
	Scopes        []string
	IsActive      bool
	LastTestAt    *time.Time
	LastTestOK    *bool
	LastTestErr   string
	UpdatedAt     time.Time
}

// CredentialRepository persists Credential rows.
type CredentialRepository interface {
	List(ctx context.Context, tenantID string) ([]Credential, error)
	Get(ctx context.Context, tenantID, provider string) (*Credential, error)
	Save(ctx context.Context, c Credential) error
	Delete(ctx context.Context, tenantID, provider string) error
	UpdateTestResult(ctx context.Context, tenantID, provider string, ok bool, errMsg string) error
}

// RoomMailbox maps a bookable resource to its Outlook room mailbox UPN.
type RoomMailbox struct {
	ResourceID  string
	TenantID    string
	MailboxUPN  string
	DisplayName string
	IsActive    bool
}

// MailboxRepository persists RoomMailbox rows.
type MailboxRepository interface {
	List(ctx context.Context, tenantID string) ([]RoomMailbox, error)
	GetByResource(ctx context.Context, resourceID string) (*RoomMailbox, error)
	Save(ctx context.Context, m RoomMailbox) error
	Delete(ctx context.Context, resourceID string) error
}

// OutlookSyncRecord ties a booking ID to the Graph event ID that
// represents it. Used by the graph_worker to update / cancel the right
// event when a booking changes.
type OutlookSyncRecord struct {
	BookingID  string
	TenantID   string
	MailboxUPN string
	GraphID    string
	ICalUID    string
	SyncedAt   time.Time
}

// OutlookSyncRepository persists OutlookSyncRecord rows.
type OutlookSyncRepository interface {
	Get(ctx context.Context, bookingID string) (*OutlookSyncRecord, error)
	Save(ctx context.Context, r OutlookSyncRecord) error
	Delete(ctx context.Context, bookingID string) error
}
