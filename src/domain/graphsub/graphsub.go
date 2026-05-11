// Package graphsub models persisted Microsoft Graph change-notification
// subscriptions. One row per (tenant, mailbox).
package graphsub

import (
	"context"
	"time"
)

// Subscription is the persisted form of a Graph subscription.
type Subscription struct {
	ID                  string
	TenantID            string
	MailboxUPN          string
	GraphSubscriptionID string
	ClientState         string
	ExpiresAt           time.Time
	LastRenewedAt       *time.Time
	CreatedAt           time.Time
}

// Repository persists Subscription rows.
type Repository interface {
	List(ctx context.Context, tenantID string) ([]Subscription, error)
	GetByMailbox(ctx context.Context, tenantID, mailboxUPN string) (*Subscription, error)
	GetByGraphID(ctx context.Context, graphID string) (*Subscription, error)
	Save(ctx context.Context, s Subscription) error
	UpdateExpiry(ctx context.Context, id string, expiry time.Time) error
	Delete(ctx context.Context, id string) error
	ListExpiringBefore(ctx context.Context, t time.Time) ([]Subscription, error)
}
