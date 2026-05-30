import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from './roles.decorator';

// Shape of req.user after the JWT strategy resolves the token.
export interface AuthUser {
  id: string;
  tenantId: string;
  username: string;
  role: Role;
  grade?: string;
  regionAccess?: string[];
}

// Pulls the populated user off the request. Saves controllers from
// reaching into `req.user` directly.
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as AuthUser;
  },
);
