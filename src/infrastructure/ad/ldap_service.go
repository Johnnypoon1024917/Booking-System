// Package ad authenticates users against an Active Directory / LDAP server.
//
// In production, set LDAP_URL (and friends) via env. If LDAP_URL is empty,
// a small dev simulator handles the well-known demo accounts so the local
// stack continues to work without a directory server.
package ad

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"

	"fsd-mrbs/src/domain/user"

	"github.com/go-ldap/ldap/v3"
)

// Service authenticates a username/password against the configured directory.
type Service interface {
	Authenticate(ctx context.Context, username, password string) (*user.User, error)
}

// NewLDAPService returns a directory-backed authenticator when LDAP_URL is
// set, falling back to the dev simulator otherwise. The legacy pointer
// signature is preserved via the LDAPService type alias below so existing
// call sites compile unchanged.
func NewLDAPService(_ string) Service {
	if url := os.Getenv("LDAP_URL"); url != "" {
		return &realLDAP{
			url:          url,
			baseDN:       os.Getenv("LDAP_BASE_DN"),
			bindTemplate: envOr("LDAP_BIND_DN_TEMPLATE", "uid=%s,ou=users,"+os.Getenv("LDAP_BASE_DN")),
			userFilter:   envOr("LDAP_USER_FILTER", "(uid=%s)"),
			roleAttr:     envOr("LDAP_ROLE_ATTR", "title"),
			gradeAttr:    envOr("LDAP_GRADE_ATTR", "employeeType"),
			regionsAttr:  envOr("LDAP_REGIONS_ATTR", "department"),
			startTLS:     envBool("LDAP_STARTTLS", true),
			insecureSkip: envBool("LDAP_INSECURE_SKIP_VERIFY", false),
			dialTimeout:  envDuration("LDAP_DIAL_TIMEOUT", 5*time.Second),
		}
	}
	return &simulator{}
}

// LDAPService is a backwards-compat alias for the previous concrete type.
type LDAPService = Service

// ============================================================================
// Real LDAP backend
// ============================================================================
type realLDAP struct {
	url          string
	baseDN       string
	bindTemplate string
	userFilter   string
	roleAttr     string
	gradeAttr    string
	regionsAttr  string
	startTLS     bool
	insecureSkip bool
	dialTimeout  time.Duration
}

func (s *realLDAP) Authenticate(_ context.Context, username, password string) (*user.User, error) {
	if username == "" || password == "" {
		return nil, errors.New("missing credentials")
	}

	conn, err := ldap.DialURL(s.url, ldap.DialWithDialer(&net.Dialer{Timeout: s.dialTimeout}))
	if err != nil {
		return nil, fmt.Errorf("ldap dial: %w", err)
	}
	defer conn.Close()

	if s.startTLS && !strings.HasPrefix(s.url, "ldaps://") {
		if err := conn.StartTLS(&tls.Config{InsecureSkipVerify: s.insecureSkip}); err != nil {
			return nil, fmt.Errorf("ldap starttls: %w", err)
		}
	}

	bindDN := fmt.Sprintf(s.bindTemplate, ldap.EscapeFilter(username))
	if err := conn.Bind(bindDN, password); err != nil {
		return nil, errors.New("invalid active directory credentials")
	}

	searchReq := ldap.NewSearchRequest(
		s.baseDN, ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 1, 5, false,
		fmt.Sprintf(s.userFilter, ldap.EscapeFilter(username)),
		[]string{"dn", "cn", s.roleAttr, s.gradeAttr, s.regionsAttr, "userAccountControl"},
		nil,
	)
	res, err := conn.Search(searchReq)
	if err != nil || len(res.Entries) == 0 {
		// Bind succeeded but lookup didn't return anything — still treat as
		// authenticated General User. Tighten when the AD schema is mapped.
		return &user.User{
			ID:       hashID(username),
			Username: username,
			DN:       bindDN,
			Role:     user.RoleGeneralUser,
			IsActive: true,
		}, nil
	}
	entry := res.Entries[0]
	return &user.User{
		ID:           hashID(entry.DN),
		Username:     username,
		DN:           entry.DN,
		Role:         mapRole(entry.GetAttributeValue(s.roleAttr)),
		Grade:        entry.GetAttributeValue(s.gradeAttr),
		IsActive:     !accountDisabled(entry.GetAttributeValue("userAccountControl")),
		RegionAccess: entry.GetAttributeValues(s.regionsAttr),
	}, nil
}

// mapRole turns LDAP `title` (or whichever attribute LDAP_ROLE_ATTR points
// at) into one of our 5 RBAC roles. Operators can use AD groups → title
// mapping at the directory level to keep this simple.
func mapRole(title string) string {
	switch strings.ToLower(strings.TrimSpace(title)) {
	case "system admin", "sysadmin", "administrator":
		return user.RoleSystemAdmin
	case "security admin", "security":
		return user.RoleSecurityAdmin
	case "room admin", "facility admin":
		return user.RoleRoomAdmin
	case "secretary", "sdo":
		return user.RoleSecretary
	default:
		return user.RoleGeneralUser
	}
}

// accountDisabled checks the AD userAccountControl ACCOUNTDISABLE bit.
func accountDisabled(uac string) bool {
	for _, b := range []string{"514", "546", "66050", "66082"} {
		if uac == b {
			return true
		}
	}
	return false
}

// hashID makes a stable, opaque user id from the DN.
func hashID(s string) string {
	h := uint32(2166136261)
	for i := 0; i < len(s); i++ {
		h ^= uint32(s[i])
		h *= 16777619
	}
	return fmt.Sprintf("ldap-%08x", h)
}

// ============================================================================
// Dev simulator
// ============================================================================
type simulator struct{}

func (simulator) Authenticate(_ context.Context, username, password string) (*user.User, error) {
	if username == "admin" && password == "admin123" {
		return &user.User{
			ID: "AD-9981", Username: username,
			DN:           "CN=System Admin,OU=IT,DC=fsd,DC=gov,DC=hk",
			Role:         user.RoleSystemAdmin,
			IsActive:     true,
			Grade:        "SDO",
			RegionAccess: []string{"Hong Kong", "Kowloon", "New Territories"},
		}, nil
	}
	if username == "officer" && password == "pass" {
		return &user.User{
			ID: "AD-1024", Username: username,
			DN:           "CN=Fire Officer,OU=Operations,DC=fsd,DC=gov,DC=hk",
			Role:         user.RoleGeneralUser,
			IsActive:     true,
			RegionAccess: []string{"Hong Kong"},
		}, nil
	}
	if username == "secretary" && password == "pass" {
		return &user.User{
			ID: "AD-2048", Username: username,
			DN:       "CN=DGFS Secretary,OU=Senior,DC=fsd,DC=gov,DC=hk",
			Role:     user.RoleSecretary,
			Grade:    "SDO",
			IsActive: true,
		}, nil
	}
	return nil, errors.New("invalid active directory credentials")
}

// ============================================================================
// helpers
// ============================================================================
func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
func envBool(k string, def bool) bool {
	v := strings.ToLower(os.Getenv(k))
	if v == "" {
		return def
	}
	return v == "true" || v == "1" || v == "yes"
}
func envDuration(k string, def time.Duration) time.Duration {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}
