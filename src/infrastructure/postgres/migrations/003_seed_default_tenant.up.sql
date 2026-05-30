-- Migration 003: seed a default tenant + sample data so a fresh deployment
-- has something to log in to and something on the dashboard.
--
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING so re-running this
-- migration (or running it on a partially-seeded database) is safe.

-- ---------------------------------------------------------------------------
-- Default tenant — UUID matches DEFAULT_TENANT_ID env var in docker-compose
-- ---------------------------------------------------------------------------
-- NOTE: This migration assumes a schema with separate JSONB columns for configuration.
-- The single 'customization_config' column appears to be from an older schema version.
INSERT INTO tenants (id, name, display_name, status, branding_config, approval_config, booking_limits)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'fsd',
    'Hong Kong Fire Services Department',
    'active',
    -- branding_config
    jsonb_build_object(
        'brand_name',               'FSD Resource Booking',
        'brand_primary',            '#0a1f44',
        'brand_secondary',          '#d71920',
        'brand_accent',             '#f7b500'
    ),
    -- approval_config
    jsonb_build_object(
        'approval_window_hours',    24,
        'weekend_require_approval', true
    ),
    -- booking_limits
    jsonb_build_object(
        'booking_horizon_days',     180,
        'min_duration_minutes',     15,
        'max_duration_minutes',     480,
        'grace_period_minutes',     15
    )
    -- Other settings like 'custom_fields', 'dashboard_widgets', etc. likely live in a separate
    -- 'customizations' table now and should be seeded there. This INSERT only handles the 'tenants' table.
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Bootstrap accounts so a fresh DB is usable: one System Admin (to manage the
-- tenant) and one General User (to exercise the booking flow). No demo
-- resources and no sample bookings — the catalog is populated by the admin
-- through the Tenant Studio.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, username, dn, role, grade, is_active, region_access)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001',
   'admin',   'CN=System Admin,OU=IT,DC=fsd,DC=gov,DC=hk',
   'System Admin',  NULL, true, ARRAY['Hong Kong','Kowloon','New Territories']),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000001',
   'user',    'CN=General User,OU=Staff,DC=fsd,DC=gov,DC=hk',
   'General User',  NULL, true, ARRAY['Hong Kong','Kowloon','New Territories'])
ON CONFLICT (tenant_id, username) DO NOTHING;
