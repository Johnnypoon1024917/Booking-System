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
	ID       string
	Username string
	DN       string
	Role     string
	IsActive bool
	Grade    string // e.g., "SDO" for Secretary validation
}
