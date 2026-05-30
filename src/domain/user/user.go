package user

// Expanded RBAC Roles for FSD
const (
	RoleSystemAdmin   = "System Admin"   // Full system access [cite: 331]
	RoleSecurityAdmin = "Security Admin" // Manages permissions [cite: 332]
	RoleRoomAdmin     = "Room Admin"     // Manages regional rooms [cite: 333]
	RoleGeneralUser   = "General User"   // Standard privileges [cite: 334]
	RoleSecretary     = "Secretary"      // Custom: Manages Top Management resources (SDO-grade)
)

type User struct {
	ID           string
	TenantID     string   // Tenant isolation
	Username     string
	DN           string
	Role         string
	IsActive     bool
	Grade        string   // e.g., "SDO" for Secretary validation
	RegionAccess []string // For Room Admin role: list of regions

	// Local credentials (app-managed, alongside AD/SSO). PasswordHash is
	// the stored bcrypt hash; Password is a transient plaintext field used
	// only to carry an admin-set initial password inbound on the JSON body
	// (never persisted, never serialised back out). MustChangePassword
	// forces a reset on next login.
	Password           string `json:"password,omitempty"`
	PasswordHash       string `json:"-"`
	MustChangePassword bool   `json:"must_change_password"`

	// DepartmentIDs is the many-to-many link to the departments table.
	// Populated by ListByTenant / GetByID via the user_departments join.
	// Save does NOT persist this slice — callers must invoke
	// SetDepartmentIDs to replace the membership set, mirroring how
	// RegionAccess used to be a separate column with its own setter
	// before it folded onto the users row.
	DepartmentIDs []string

	// MFA — populated by the user repository; LDAP/SCIM-only fields are
	// left at zero values for callers that don't need them.
	MFAEnabled bool
	MFASecret  string
}
