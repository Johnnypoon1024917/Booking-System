import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSION_KEY } from '../decorators/require-permission.decorator';
import { Roles } from '../decorators/roles.decorator';
import { PermissionsService } from '../../modules/permissions/permissions.service';

// Enforces the fine-grained permission matrix that admins configure but which
// was previously never checked (authorization was only the coarse 5-role
// guard). Reads @RequirePermission(...) metadata and verifies the caller's
// role holds every listed permission in their tenant's matrix.
//
// Runs as a global guard AFTER JwtAuthGuard, so req.user is populated. Routes
// without @RequirePermission are unaffected. System Admin is a superuser and
// always passes (it also holds every permission by default). A role with no
// configured row falls back to catalog defaults, so enabling this guard never
// locks out a tenant that hasn't customised its matrix.
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(
      PERMISSION_KEY, [ctx.getHandler(), ctx.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user?.tenantId || !user?.role) {
      throw new ForbiddenException('missing authorization context');
    }
    // System Admin bypass — the tenant's break-glass superuser.
    if (user.role === Roles.SystemAdmin) return true;

    for (const perm of required) {
      if (!(await this.permissions.hasPermission(user.tenantId, user.role, perm))) {
        throw new ForbiddenException(`missing required permission: ${perm}`);
      }
    }
    return true;
  }
}
