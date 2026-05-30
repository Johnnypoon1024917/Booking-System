import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// 1 row per tenant. The payload is intentionally JSONB so adding a
// branding/layout field is a SPA-only change — no migration required.
@Entity('tenant_customizations')
export class Customization {
  @PrimaryColumn({ name: 'tenant_id', type: 'uuid' }) tenantId!: string;
  @Column({ type: 'jsonb', default: () => `'{}'::jsonb` }) data!: Record<string, any>;
  // Optimistic-concurrency token. Bumped on every save; a save that carries a
  // stale version is rejected with a 409 so two admins editing the same tenant
  // can't silently clobber each other ("last writer wins" wipeout).
  @Column({ type: 'int', default: 0 }) version!: number;
  @UpdateDateColumn({ name: 'updated_at' }) updatedAt!: Date;
}

// Default shape — matches v1's tenant.Customization.applyDefaults().
export const defaultCustomization = {
  brand_name: 'FSD MRBS',
  brand_primary: '#002147',
  brand_secondary: '#475569',
  brand_accent: '#f59e0b',
  brand_logo_url: '',
  default_locale: 'en',
  available_locales: ['en', 'zh-Hant', 'zh-Hans'],
  timezone: 'Asia/Hong_Kong',
  weekend_days: [6, 7],
  calendar_start_hour: 8,
  calendar_end_hour: 20,
  sidebar_modules: ['dashboard', 'calendar', 'search', 'my-bookings', 'reports', 'admin'],
  dashboard_widgets: [],
  custom_fields: [],
  recurrence_patterns: ['daily', 'weekly', 'monthly'],
  hko_weather_enabled: true,
  govhk_holidays_enabled: false,
  // Regions that gov.hk public holidays apply to. Empty = tenant-wide (every
  // resource). For a multi-region tenant (e.g. HK + Singapore offices) list the
  // Hong Kong regions here so the feed only closes HK rooms. Shared by the
  // manual sync and the nightly cron.
  govhk_holiday_regions: [] as string[],
  // Chargeback / cost-center codes a booker must pick from. Empty = the
  // tenant runs no chargeback codes and the field stays optional everywhere.
  cost_centers: [] as string[],
  // Ghost-booking auto-release. `enabled` is intentionally omitted from the
  // default so an unconfigured tenant falls back to the AUTO_RELEASE_ENABLED
  // env switch (backwards-compatible); once an admin toggles it in Tenant
  // Studio the explicit value wins. grace_minutes is the tenant-wide default
  // a per-resource ruleOverrides.graceMinutes can still tighten.
  auto_release: { grace_minutes: 15 } as { enabled?: boolean; grace_minutes: number },
};
