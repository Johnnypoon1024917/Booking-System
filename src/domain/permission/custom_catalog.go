// custom_catalog.go — admin-extensible permission catalog.
//
// Built-in groups + keys are defined in catalog.go and represent the
// floor every tenant ships with. Tenants can ALSO define their own
// groups and keys via /api/v1/admin/permission-catalog. The permissions
// page renders the union (built-in first, then custom).
package permission

import "context"

type CustomGroup struct {
	ID           string `json:"id"`
	TenantID     string `json:"tenant_id"`
	Key          string `json:"key"`
	Label        string `json:"label"`
	DisplayOrder int    `json:"display_order"`
}

type CustomPermission struct {
	ID          string `json:"id"`
	TenantID    string `json:"tenant_id"`
	GroupKey    string `json:"group_key"`
	Key         string `json:"key"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// CatalogRepository persists tenant-defined groups and permissions.
type CatalogRepository interface {
	ListGroups(ctx context.Context, tenantID string) ([]CustomGroup, error)
	ListPermissions(ctx context.Context, tenantID string) ([]CustomPermission, error)
	SaveGroup(ctx context.Context, g CustomGroup) error
	DeleteGroup(ctx context.Context, tenantID, key string) error
	SavePermission(ctx context.Context, p CustomPermission) error
	DeletePermission(ctx context.Context, tenantID, key string) error
}
