package auth

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/user"
	"time"
)

// IdentityProvider defines the interface for external identity provider integrations.
// This abstraction allows plugging in different authentication backends (LDAP, SAML, OAuth2)
// while maintaining consistent behavior across the system.
type IdentityProvider interface {
	// Authenticate validates user credentials against the identity provider.
	// Returns the authenticated user with their roles and attributes, or an error.
	Authenticate(ctx context.Context, username, password string) (*user.User, error)

	// SyncUser synchronizes user data from the identity provider to the local system.
	// This ensures user attributes, roles, and status remain consistent.
	SyncUser(ctx context.Context, userID string) error

	// CheckDisabled queries the identity provider to determine if a user account is disabled.
	// Returns true if the account is disabled, false if active.
	CheckDisabled(ctx context.Context, userID string) (bool, error)
}

// ProviderType represents the type of identity provider
type ProviderType string

const (
	ProviderTypeLDAP   ProviderType = "ldap"
	ProviderTypeSAML   ProviderType = "saml"
	ProviderTypeOAuth2 ProviderType = "oauth2"
)

// ErrNotImplemented is returned when a provider method is not yet implemented
var ErrNotImplemented = errors.New("identity provider method not implemented")

// ProviderConfig contains common configuration for identity providers
type ProviderConfig struct {
	Type     ProviderType
	Endpoint string
	Timeout  time.Duration
}
