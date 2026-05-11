-- Migration 003: seed a default tenant + sample data so a fresh deployment
-- has something to log in to and something on the dashboard.
--
-- Idempotent: every INSERT uses ON CONFLICT DO NOTHING so re-running this
-- migration (or running it on a partially-seeded database) is safe.

-- ---------------------------------------------------------------------------
-- Default tenant — UUID matches DEFAULT_TENANT_ID env var in docker-compose
-- ---------------------------------------------------------------------------
INSERT INTO tenants (id, name, display_name, status, branding_config, customization_config)
VALUES (
    '00000000-0000-0000-0000-000000000001',
    'fsd',
    'Hong Kong Fire Services Department',
    'active',
    '{"logo_url":"","color_scheme":"fsd"}'::jsonb,
    jsonb_build_object(
        'tenant_id',                '00000000-0000-0000-0000-000000000001',
        'brand_name',               'FSD Resource Booking',
        'brand_primary',            '#0a1f44',
        'brand_secondary',          '#d71920',
        'brand_accent',             '#f7b500',
        'default_locale',           'en',
        'available_locales',        ARRAY['en','zh-Hant','zh-Hans'],
        'timezone',                 'Asia/Hong_Kong',
        'dashboard_widgets',        ARRAY['kpi-active','kpi-utilisation','kpi-pending','kpi-noshow','calendar-week','agenda','activity'],
        'sidebar_modules',          ARRAY['dashboard','search','my-bookings','approvals','reports','admin'],
        'weekend_days',             ARRAY[6,7],
        'booking_horizon_days',     180,
        'min_duration_minutes',     15,
        'max_duration_minutes',     480,
        'grace_period_minutes',     15,
        'approval_window_hours',    24,
        'weekend_require_approval', true,
        'holiday_blocking',         true,
        'hko_weather_enabled',      true,
        'gov_hk_holiday_feed',      true,
        'zoom_mask_base',           'https://ess.hkfsd.hksarg/redirect',
        'role_labels', jsonb_build_object(
            'System Admin',   'System Admin',
            'Security Admin', 'Security Admin',
            'Room Admin',     'Room Admin',
            'General User',   'General User',
            'Secretary',      'Secretary (SDO)'
        ),
        'custom_fields', jsonb_build_array(
            jsonb_build_object(
                'key',      'purpose_code',
                'type',     'select',
                'required', true,
                'options',  ARRAY['Operational','Training','Briefing','VIP'],
                'label',    jsonb_build_object('en','Purpose','zh-Hant','用途','zh-Hans','用途')
            ),
            jsonb_build_object(
                'key',      'attendee_count',
                'type',     'number',
                'required', false,
                'label',    jsonb_build_object('en','Expected Attendees','zh-Hant','預計出席人數','zh-Hans','预计出席人数')
            )
        )
    )
)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Bootstrap admin so SOMEONE can log in on a fresh DB. No demo officer,
-- no sample resources, no sample holidays — admin is expected to populate
-- their own catalog through the Tenant Studio.
-- ---------------------------------------------------------------------------
INSERT INTO users (id, tenant_id, username, dn, role, grade, is_active, region_access)
VALUES
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000001',
   'admin',   'CN=System Admin,OU=IT,DC=fsd,DC=gov,DC=hk',
   'System Admin', NULL, true, ARRAY['Hong Kong','Kowloon','New Territories'])
ON CONFLICT (tenant_id, username) DO NOTHING;
