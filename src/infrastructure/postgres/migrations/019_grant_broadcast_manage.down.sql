-- Revert broadcast.manage grant.
UPDATE role_permissions
SET permissions = array_remove(permissions, 'broadcast.manage')
WHERE role IN ('System Admin', 'Room Admin');
