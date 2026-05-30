-- Grant broadcast.manage to System Admin and Room Admin.
--
-- Background: migration 007 seeded the role-permissions matrix but the
-- broadcast.manage key was never assigned to any role, so every authenticated
-- admin hit a 403 when visiting /admin/broadcasts. The handler at
-- application/api/handlers/broadcast_handler.go gates on this key via
-- permission middleware, so the only fix is to grant it.
--
-- Idempotent: appends only if the key isn't already present.

UPDATE role_permissions
SET permissions = array_append(permissions, 'broadcast.manage')
WHERE role = 'System Admin'
  AND NOT ('broadcast.manage' = ANY(permissions));

UPDATE role_permissions
SET permissions = array_append(permissions, 'broadcast.manage')
WHERE role = 'Room Admin'
  AND NOT ('broadcast.manage' = ANY(permissions));
