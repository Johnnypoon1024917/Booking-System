import { SetMetadata } from '@nestjs/common';

// Mirrors the role names from v1's domain/user/user.go so the SPA
// and JWT payload are 1:1 compatible across both stacks.
export const Roles = {
  SystemAdmin: 'System Admin',
  SecurityAdmin: 'Security Admin',
  RoomAdmin: 'Room Admin',
  Secretary: 'Secretary',
  GeneralUser: 'General User',
} as const;
export type Role = (typeof Roles)[keyof typeof Roles];

export const ROLES_KEY = 'roles';
export const RequireRoles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

// Convenience: any admin-tier role.
export const AdminRoles: Role[] = [
  Roles.SystemAdmin,
  Roles.SecurityAdmin,
  Roles.RoomAdmin,
  Roles.Secretary,
];
