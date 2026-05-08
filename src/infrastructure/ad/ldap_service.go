package ad

import (
	"context"
	"errors"
	"fsd-mrbs/src/domain/user"
)

type LDAPService struct {
	serverURL string
}

func NewLDAPService(url string) *LDAPService {
	return &LDAPService{serverURL: url}
}

// Authenticate simulates the FSD Active Directory SSO process
func (s *LDAPService) Authenticate(ctx context.Context, username, password string) (*user.User, error) {
	// Simulated LDAP Bind & Search...
	if username == "admin" && password == "admin123" {
		return &user.User{
			ID:       "AD-9981",
			Username: username,
			DN:       "CN=System Admin,OU=IT,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleSystemAdmin,
			IsActive: true,
		}, nil
	}

	if username == "officer" && password == "pass" {
		return &user.User{
			ID:       "AD-1024",
			Username: username,
			DN:       "CN=Fire Officer,OU=Operations,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleGeneralUser,
			IsActive: true,
		}, nil
	}

	return nil, errors.New("invalid active directory credentials")
}
