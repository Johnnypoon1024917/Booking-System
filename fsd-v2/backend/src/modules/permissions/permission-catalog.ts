// Canonical permission catalog — mirrors v1 domain/permission/catalog.go.
// New keys added here automatically appear in the admin matrix UI.

export const Perm = {
  BookingCreate: 'booking.create',
  BookingCancel: 'booking.cancel',
  BookingCancelOthers: 'booking.cancel_others',
  BookingUpdate: 'booking.update',
  BookingReadAll: 'booking.read_all',

  ResourceCreate: 'resource.create',
  ResourceUpdate: 'resource.update',
  ResourceDelete: 'resource.delete',
  ResourceSplit: 'resource.split',

  UserCreate: 'user.create',
  UserUpdate: 'user.update',
  UserDeactivate: 'user.deactivate',

  DepartmentManage: 'department.manage',
  HolidayManage: 'holiday.manage',
  HolidayImport: 'holiday.import',

  ApprovalDecide: 'approval.decide',
  ApprovalDelegate: 'approval.delegate',
  ApprovalBypass: 'approval.bypass',
  ApprovalRuleManage: 'approval_rule.manage',

  WebhookManage: 'webhook.manage',
  IntegrationManage: 'integration.manage',
  PermissionManage: 'permission.manage',

  ReportView: 'report.view',
  ReportExport: 'report.export',

  CustomizationManage: 'customization.manage',
  AuditView: 'audit.view',
  TenantManage: 'tenant.manage',
  ServiceManage: 'service.manage',
  BroadcastManage: 'broadcast.manage',
} as const;

export interface PermissionGroup {
  title: string;
  keys: string[];
}

export function catalog(): PermissionGroup[] {
  return [
    { title: 'Bookings', keys: [
      Perm.BookingCreate, Perm.BookingCancel, Perm.BookingCancelOthers, Perm.BookingUpdate, Perm.BookingReadAll,
    ]},
    { title: 'Resources', keys: [
      Perm.ResourceCreate, Perm.ResourceUpdate, Perm.ResourceDelete, Perm.ResourceSplit,
    ]},
    { title: 'Services', keys: [Perm.ServiceManage] },
    { title: 'Users', keys: [Perm.UserCreate, Perm.UserUpdate, Perm.UserDeactivate] },
    { title: 'Workspace', keys: [
      Perm.DepartmentManage, Perm.HolidayManage, Perm.HolidayImport, Perm.BroadcastManage,
    ]},
    { title: 'Approvals', keys: [
      Perm.ApprovalDecide, Perm.ApprovalDelegate, Perm.ApprovalBypass, Perm.ApprovalRuleManage,
    ]},
    { title: 'Integrations', keys: [Perm.WebhookManage, Perm.IntegrationManage, Perm.PermissionManage] },
    { title: 'Insights', keys: [Perm.ReportView, Perm.ReportExport, Perm.AuditView] },
    { title: 'Tenant', keys: [Perm.CustomizationManage, Perm.TenantManage] },
  ];
}

// The built-in roles every tenant ships with. These can be re-permissioned in
// the matrix but never deleted (and their names are reserved for custom roles),
// so the authorization model always has a known baseline. Any role NOT in this
// list is a tenant-defined custom role and is freely deletable.
export function systemRoles(): string[] {
  return Object.keys(defaultMatrix());
}

// Default per-role assignments seeded on first read of a tenant's matrix
// — keeps the legacy roles wired up out of the box.
export function defaultMatrix(): Record<string, string[]> {
  return {
    'System Admin': Object.values(Perm),
    'Security Admin': [
      Perm.BookingReadAll, Perm.ApprovalDecide, Perm.ApprovalDelegate, Perm.AuditView,
      Perm.UserUpdate, Perm.PermissionManage,
    ],
    'Room Admin': [
      Perm.BookingCreate, Perm.BookingCancel, Perm.BookingCancelOthers, Perm.BookingUpdate, Perm.BookingReadAll,
      Perm.ResourceCreate, Perm.ResourceUpdate, Perm.ResourceDelete, Perm.ResourceSplit,
      Perm.ApprovalDecide, Perm.ApprovalDelegate, Perm.ReportView, Perm.ReportExport,
    ],
    'Secretary': [
      Perm.BookingCreate, Perm.BookingCancel, Perm.BookingUpdate, Perm.BookingReadAll, Perm.ApprovalDecide,
    ],
    'General User': [Perm.BookingCreate, Perm.BookingCancel, Perm.BookingUpdate],
  };
}
