package auth

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/auth"
	"fsd-mrbs/src/domain/user"
)

// LDAPConfig holds the configuration for LDAP identity provider
type LDAPConfig struct {
	ServerURL string
	BindDN    string
	BindPwd   string
	BaseDN    string
	Timeout   int // seconds
}

// LDAPProvider implements IdentityProvider for LDAP/Active Directory
type LDAPProvider struct {
	config LDAPConfig
}

// NewLDAPProvider creates a new LDAP identity provider
func NewLDAPProvider(config LDAPConfig) *LDAPProvider {
	return &LDAPProvider{
		config: config,
	}
}

// Authenticate validates user credentials against LDAP/Active Directory.
// This provider is a placeholder for tenants that select ProviderTypeLDAP via
// tenant config. The real wire-level LDAP bind path lives in infrastructure/ad,
// driven by env (LDAP_URL, LDAP_BASE_DN, ...). Until this provider is wired to
// a configured directory it MUST refuse all credentials so a misconfigured
// deploy fails closed rather than presenting a usable login surface.
func (p *LDAPProvider) Authenticate(ctx context.Context, username, password string) (*user.User, error) {
	if p.config.ServerURL == "" {
		return nil, errors.New("ldap provider not configured")
	}
	return nil, auth.ErrNotImplemented
}

// SyncUser synchronizes user data from LDAP to the local system
// In production, this would query LDAP for user attributes and update local storage
func (p *LDAPProvider) SyncUser(ctx context.Context, userID string) error {
	// TODO: Implement LDAP user sync
	// This would:
	// 1. Query LDAP for user attributes (department, title, manager)
	// 2. Update local user record
	// 3. Sync group memberships to roles
	return nil
}

// CheckDisabled queries LDAP to check if a user account is disabled
// In production, this would check the userAccountControl attribute in Active Directory
func (p *LDAPProvider) CheckDisabled(ctx context.Context, userID string) (bool, error) {
	// TODO: Implement LDAP disabled check
	// This would query the userAccountControl attribute:
	// - ACCOUNTDISABLE flag (0x0002) indicates disabled account
	return false, nil
}

// Ensure LDAPProvider implements IdentityProvider interface
var _ auth.IdentityProvider = (*LDAPProvider)(nil)

// GetProviderType returns the provider type for LDAP
func (p *LDAPProvider) GetProviderType() auth.ProviderType {
	return auth.ProviderTypeLDAP
}

// Health checks connectivity to the LDAP server
func (p *LDAPProvider) Health(ctx context.Context) error {
	// TODO: Implement LDAP health check
	// This would perform a bind operation to verify connectivity
	return nil
}
