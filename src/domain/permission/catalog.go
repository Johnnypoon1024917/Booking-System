// Package permission defines the canonical permission catalog and the
// in-memory representation of a tenant's role-permissions matrix.
//
// The 5 built-in roles still gate "what menu can you see" coarsely, but
// every meaningful action is also gated by a permission key from this
// catalog. Tenants can rebalance the matrix without code changes.
package permission

import "context"

// Permission keys — keep additions backwards compatible.
const (
	BookingCreate        = "booking.create"
	BookingCancel        = "booking.cancel"
	BookingCancelOthers  = "booking.cancel_others"
	BookingUpdate        = "booking.update"
	BookingReadAll       = "booking.read_all"

	ResourceCreate  = "resource.create"
	ResourceUpdate  = "resource.update"
	ResourceDelete  = "resource.delete"
	ResourceSplit   = "resource.split"

	UserCreate     = "user.create"
	UserUpdate     = "user.update"
	UserDeactivate = "user.deactivate"

	DepartmentManage = "department.manage"
	HolidayManage    = "holiday.manage"
	HolidayImport    = "holiday.import"

	ApprovalDecide   = "approval.decide"
	ApprovalDelegate = "approval.delegate"
	ApprovalBypass   = "approval.bypass"
	ApprovalRuleManage = "approval_rule.manage"

	WebhookManage     = "webhook.manage"
	IntegrationManage = "integration.manage"
	PermissionManage  = "permission.manage"

	ReportView   = "report.view"
	ReportExport = "report.export"

	CustomizationManage = "customization.manage"
	AuditView           = "audit.view"
	TenantManage        = "tenant.manage"
	ServiceManage       = "service.manage"
	BroadcastManage     = "broadcast.manage"
)

// Catalog returns the full set of permission keys grouped for the UI.
// The frontend renders a checkbox matrix from this; new permissions
// added here automatically appear in the admin page.
func Catalog() []Group {
	return []Group{
		{Title: "Bookings", Keys: []string{
			BookingCreate, BookingCancel, BookingCancelOthers, BookingUpdate, BookingReadAll,
		}},
		{Title: "Resources", Keys: []string{
			ResourceCreate, ResourceUpdate, ResourceDelete, ResourceSplit,
		}},
		{Title: "Services", Keys: []string{
			ServiceManage,
		}},
		{Title: "Users", Keys: []string{
			UserCreate, UserUpdate, UserDeactivate,
		}},
		{Title: "Workspace", Keys: []string{
			DepartmentManage, HolidayManage, HolidayImport, BroadcastManage,
		}},
		{Title: "Approvals", Keys: []string{
			ApprovalDecide, ApprovalDelegate, ApprovalBypass, ApprovalRuleManage,
		}},
		{Title: "Integrations", Keys: []string{
			WebhookManage, IntegrationManage, PermissionManage,
		}},
		{Title: "Insights", Keys: []string{
			ReportView, ReportExport, AuditView,
		}},
		{Title: "Tenant", Keys: []string{
			CustomizationManage, TenantManage,
		}},
	}
}

// Group is one section of permissions for UI rendering.
type Group struct {
	Title string   `json:"title"`
	Keys  []string `json:"keys"`
}

// RoleMatrix is the per-tenant view of which roles have which permissions.
type RoleMatrix struct {
	TenantID string              `json:"tenant_id"`
	Roles    map[string][]string `json:"roles"` // role → permission keys
}

// Repository persists role permissions.
type Repository interface {
	Get(ctx context.Context, tenantID string) (*RoleMatrix, error)
	Set(ctx context.Context, tenantID, role string, permissions []string) error
}

// Has reports whether a given role currently holds a permission.
func (m *RoleMatrix) Has(role, key string) bool {
	if m == nil {
		return false
	}
	for _, p := range m.Roles[role] {
		if p == key {
			return true
		}
	}
	return false
}
