-- 031_visibility_acl.up.sql
--
-- Enterprise three-permission model for booking visibility, modelled on
-- Exchange / Google Calendar:
--
--   visibility — "the resource exists"        — resources.is_active, asset_type, is_restricted
--   free/busy  — "the slot is taken"          — every booker sees this for every visible resource
--   details   — "who, what, why"              — owner + admins by default; widen per resource
--
-- Two additions land here:
--
-- 1) resources.details_visible_to_role:
--
--    NULL or empty  → details visible to owner + System/Security/Room
--                     Admin + Secretary (legacy behaviour).
--    {General User} → every booker sees subject/organiser. Use this for
--                     public common-area rooms ("Conference Room A —
--                     Annual Town Hall" should show to everyone).
--    {Room Admin}   → narrower than default; details ONLY to Room
--                     Admins and System Admins.
--
--    The array is additive on top of the always-allowed defaults
--    (owner, System Admin). It widens, never narrows below the floor —
--    System Admin always sees details so an audit trail is reachable.
--
-- 2) bookings.is_private:
--
--    When TRUE the booking is rendered as "Reserved" to everyone except
--    the owner and System Admins, regardless of the resource's
--    details_visible_to_role grant. This lets a user mark a single
--    booking sensitive ("1:1 with CEO") on an otherwise public room.
--    Modelled on Outlook's "Private" appointment flag.
--
-- The columns are nullable / defaulted to keep the migration compatible
-- with existing rows; no data backfill required. The domain projection
-- code defaults to legacy behaviour when both are unset.

ALTER TABLE resources
    ADD COLUMN IF NOT EXISTS details_visible_to_role TEXT[];

ALTER TABLE bookings
    ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;

-- Speeds up the projection's "does this role appear in the ACL?" check.
-- GIN works well on small TEXT[] arrays (we expect 0-5 entries per row).
CREATE INDEX IF NOT EXISTS idx_resources_details_acl
    ON resources USING GIN (details_visible_to_role)
    WHERE details_visible_to_role IS NOT NULL;

-- The privacy flag is a hot filter — when an admin opens the booking
-- detail view we have to check it before rendering PII. Partial index
-- because the overwhelming majority of bookings are not private.
CREATE INDEX IF NOT EXISTS idx_bookings_private
    ON bookings(tenant_id, id)
    WHERE is_private = TRUE;

COMMENT ON COLUMN resources.details_visible_to_role IS
    'Per-resource details ACL. NULL = legacy default (owner + admins + Secretary). '
    'Roles listed here gain details access in ADDITION to the default set; '
    'System Admin and the booking owner are always granted.';

COMMENT ON COLUMN bookings.is_private IS
    'Per-booking privacy flag (Outlook semantics). When TRUE, only the '
    'owner and System Admin see organiser/subject/meeting URL; everyone '
    'else gets "Reserved" — even if the resource ACL would otherwise '
    'allow details.';
