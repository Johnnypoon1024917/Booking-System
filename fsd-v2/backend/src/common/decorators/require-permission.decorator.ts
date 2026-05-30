import { SetMetadata } from '@nestjs/common';

// Attaches one or more fine-grained permission keys (see permission-catalog)
// to a route. The global PermissionsGuard reads them and checks the caller's
// role against the tenant's configured permission matrix. Multiple keys are
// AND-ed: the caller must hold every listed permission.
export const PERMISSION_KEY = 'required_permissions';
export const RequirePermission = (...permissions: string[]) =>
  SetMetadata(PERMISSION_KEY, permissions);
