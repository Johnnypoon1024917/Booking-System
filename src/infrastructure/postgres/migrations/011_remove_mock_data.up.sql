-- Migration 011: remove all demo / mock-up data seeded by 003 + 004.
--
-- Earlier migrations seeded a demo officer user, 11 sample resources
-- (boardroom, vehicles, drone, the basketball/badminton split, …),
-- 3 sample holidays, and 4 default departments. We're cleaning these
-- so a fresh deployment shows an empty catalog and admins populate
-- everything through the Tenant Studio.
--
-- The default tenant + admin user stay in place — without them no one
-- could log in to clean things up.

-- Demo bookings against demo resources first (FK cascade would handle
-- it, but be explicit so this works even if cascade was disabled).
DELETE FROM bookings
 WHERE resource_id IN (
   'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000003',
   'a0000000-0000-0000-0000-000000000004',
   'a0000000-0000-0000-0000-000000000005',
   'a0000000-0000-0000-0000-000000000006',
   'a0000000-0000-0000-0000-000000000007',
   'a0000000-0000-0000-0000-000000000010',
   'a0000000-0000-0000-0000-000000000011',
   'a0000000-0000-0000-0000-000000000012',
   'a0000000-0000-0000-0000-000000000013'
 );

-- Children first (so the parent FK doesn't refuse).
DELETE FROM resources
 WHERE id IN (
   'a0000000-0000-0000-0000-000000000011',
   'a0000000-0000-0000-0000-000000000012',
   'a0000000-0000-0000-0000-000000000013'
 );

DELETE FROM resources
 WHERE id IN (
   'a0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002',
   'a0000000-0000-0000-0000-000000000003',
   'a0000000-0000-0000-0000-000000000004',
   'a0000000-0000-0000-0000-000000000005',
   'a0000000-0000-0000-0000-000000000006',
   'a0000000-0000-0000-0000-000000000007',
   'a0000000-0000-0000-0000-000000000010'
 );

DELETE FROM holidays
 WHERE id IN (
   'b0000000-0000-0000-0000-000000000001',
   'b0000000-0000-0000-0000-000000000002',
   'b0000000-0000-0000-0000-000000000003'
 );

DELETE FROM departments
 WHERE id IN (
   'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002',
   'd0000000-0000-0000-0000-000000000003',
   'd0000000-0000-0000-0000-000000000004'
 );

-- Demo officer user.
DELETE FROM users
 WHERE id = '22222222-2222-2222-2222-222222222222';
