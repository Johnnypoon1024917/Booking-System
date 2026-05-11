package usecase

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"fsd-mrbs/src/domain/graphsub"
	"fsd-mrbs/src/domain/integration"
	infraint "fsd-mrbs/src/infrastructure/integration"
)

// ManageGraphSubscriptionsUseCase creates / renews / cancels the
// Microsoft Graph change-notification subscriptions backing every mapped
// room mailbox.
//
// Drives:
//   - on-demand: when a mailbox map is added, EnsureSubscription is called
//     so the new mailbox starts streaming immediately.
//   - scheduler: RenewExpiring runs hourly to extend any subscription
//     within 12h of its 70.5h ceiling.
type ManageGraphSubscriptionsUseCase struct {
	creds      integration.CredentialRepository
	mailboxes  integration.MailboxRepository
	subs       graphsub.Repository
	graph      *infraint.GraphClient
	notifyURL  string
}

func NewManageGraphSubscriptionsUseCase(
	c integration.CredentialRepository,
	m integration.MailboxRepository,
	s graphsub.Repository,
	g *infraint.GraphClient,
	notifyURL string,
) *ManageGraphSubscriptionsUseCase {
	return &ManageGraphSubscriptionsUseCase{creds: c, mailboxes: m, subs: s, graph: g, notifyURL: notifyURL}
}

// EnsureSubscription is idempotent — if a subscription already exists for
// (tenant, mailbox), it's renewed; otherwise a new one is created.
func (uc *ManageGraphSubscriptionsUseCase) EnsureSubscription(ctx context.Context, tenantID, mailboxUPN string) error {
	if uc.notifyURL == "" {
		return errors.New("GRAPH_NOTIFY_URL not configured")
	}
	cred, err := uc.creds.Get(ctx, tenantID, integration.ProviderMicrosoft)
	if err != nil {
		return err
	}
	tok, err := uc.graph.Token(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret)
	if err != nil {
		return err
	}
	existing, _ := uc.subs.GetByMailbox(ctx, tenantID, mailboxUPN)
	if existing != nil {
		// Renew if it's close to expiring.
		if infraint.NeedsRenewal(existing.ExpiresAt) {
			when, err := uc.graph.RenewSubscription(ctx, tok, existing.GraphSubscriptionID)
			if err != nil {
				return err
			}
			return uc.subs.UpdateExpiry(ctx, existing.ID, when)
		}
		return nil
	}

	clientState := NewClientState()
	created, err := uc.graph.CreateSubscription(ctx, tok, mailboxUPN, uc.notifyURL, clientState)
	if err != nil {
		return err
	}
	return uc.subs.Save(ctx, graphsub.Subscription{
		TenantID:            tenantID,
		MailboxUPN:          mailboxUPN,
		GraphSubscriptionID: created.ID,
		ClientState:         clientState,
		ExpiresAt:           created.ExpirationDateTime,
	})
}

// RenewExpiring is the scheduler entry point.
func (uc *ManageGraphSubscriptionsUseCase) RenewExpiring(ctx context.Context) (int, error) {
	cutoff := time.Now().Add(12 * time.Hour)
	due, err := uc.subs.ListExpiringBefore(ctx, cutoff)
	if err != nil {
		return 0, err
	}
	renewed := 0
	for _, s := range due {
		cred, err := uc.creds.Get(ctx, s.TenantID, integration.ProviderMicrosoft)
		if err != nil {
			slog.Warn("renew: missing credentials", "tenant", s.TenantID, "err", err)
			continue
		}
		tok, err := uc.graph.Token(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret)
		if err != nil {
			slog.Warn("renew: token", "err", err)
			continue
		}
		when, err := uc.graph.RenewSubscription(ctx, tok, s.GraphSubscriptionID)
		if err != nil {
			slog.Warn("renew: graph", "id", s.GraphSubscriptionID, "err", err)
			continue
		}
		if err := uc.subs.UpdateExpiry(ctx, s.ID, when); err == nil {
			renewed++
		}
	}
	return renewed, nil
}

// Remove cancels the subscription on Graph and deletes the local row.
// Called when a mailbox map is removed or the integration is disconnected.
func (uc *ManageGraphSubscriptionsUseCase) Remove(ctx context.Context, tenantID, mailboxUPN string) error {
	existing, _ := uc.subs.GetByMailbox(ctx, tenantID, mailboxUPN)
	if existing == nil {
		return nil
	}
	cred, err := uc.creds.Get(ctx, tenantID, integration.ProviderMicrosoft)
	if err == nil {
		if tok, e := uc.graph.Token(ctx, cred.AzureTenantID, cred.ClientID, cred.ClientSecret); e == nil {
			_ = uc.graph.DeleteSubscription(ctx, tok, existing.GraphSubscriptionID)
		}
	}
	return uc.subs.Delete(ctx, existing.ID)
}
