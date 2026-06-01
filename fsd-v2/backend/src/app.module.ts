import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { databaseConfig } from './config/database.config';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { TenantTxInterceptor } from './common/interceptors/tenant-tx.interceptor';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { RlsService } from './common/rls.service';

import { AuthModule } from './modules/auth/auth.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { DepartmentsModule } from './modules/departments/departments.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { CustomizationModule } from './modules/customization/customization.module';
import { AuditModule } from './modules/audit/audit.module';
import { ReportsModule } from './modules/reports/reports.module';
import { DsarModule } from './modules/dsar/dsar.module';
import { ApprovalsModule } from './modules/approvals/approvals.module';
import { PermissionsModule } from './modules/permissions/permissions.module';
import { BroadcastsModule } from './modules/broadcasts/broadcasts.module';
import { HolidaysModule } from './modules/holidays/holidays.module';
import { WeatherModule } from './modules/weather/weather.module';
import { PushModule } from './modules/push/push.module';
import { MfaModule } from './modules/mfa/mfa.module';
import { WebauthnModule } from './modules/webauthn/webauthn.module';
import { SsoModule } from './modules/sso/sso.module';
import { ScimModule } from './modules/scim/scim.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
import { GraphModule } from './modules/graph/graph.module';
import { OutlookSyncModule } from './modules/outlook-sync/outlook-sync.module';
import { GoogleSyncModule } from './modules/google-sync/google-sync.module';
import { TeamsModule } from './modules/teams/teams.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { LocationsModule } from './modules/locations/locations.module';
import { LocationGroupsModule } from './modules/location-groups/location-groups.module';
import { ResourceTypesModule } from './modules/resource-types/resource-types.module';
import { ServicesModule } from './modules/services/services.module';
import { FloorPlansModule } from './modules/floor-plans/floor-plans.module';
import { SensorsModule } from './modules/sensors/sensors.module';
import { VisitorsModule } from './modules/visitors/visitors.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { KioskModule } from './modules/kiosk/kiosk.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { HealthController } from './common/health.controller';
import { SeederService } from './common/seeder.service';
import { DemoSeederService } from './common/demo-seeder.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(databaseConfig()),
    ScheduleModule.forRoot(),
    // Audit is loaded early because most other modules inject it.
    AuditModule,
    AuthModule,
    TenantsModule,
    DepartmentsModule,
    UsersModule,
    ResourcesModule,
    BookingsModule,
    CustomizationModule,
    ReportsModule,
    DsarModule,
    ApprovalsModule,
    PermissionsModule,
    BroadcastsModule,
    HolidaysModule,
    WeatherModule,
    PushModule,
    MfaModule,
    WebauthnModule,
    SsoModule,
    ScimModule,
    // External integrations: encrypted creds + per-system adapters.
    // IntegrationsModule must come before the rest so its
    // CredentialService provider is available to inject.
    IntegrationsModule,
    GraphModule,
    OutlookSyncModule,
    GoogleSyncModule,
    TeamsModule,
    WebhooksModule,
    // Email notification outbox + per-tenant templates (SMTP). Mirrors
    // v1's notification worker; drains via an EVERY_MINUTE cron.
    NotificationsModule,
    // Facility-side surfaces (locations, groups, types, services,
    // floor plans, sensors, visitors, invoices, kiosk).
    LocationsModule,
    LocationGroupsModule,
    ResourceTypesModule,
    ServicesModule,
    FloorPlansModule,
    SensorsModule,
    VisitorsModule,
    InvoicesModule,
    KioskModule,
    // SSE event bus — @Global so any module can inject RealtimeGateway
    // and emit() lifecycle events that the SPA's EventSource picks up.
    RealtimeModule,
  ],
  controllers: [HealthController],
  providers: [
    // Rate-limit guard runs first so flooded auth endpoints are rejected
    // before the (expensive, bcrypt-heavy) auth handlers. Only acts on
    // routes annotated with @RateLimit; all others pass through.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    // Global JWT guard — every route is protected by default.
    // Controllers opt out with @Public() (see common/decorators).
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Fine-grained permission-matrix enforcement. Runs after the JWT guard
    // (needs req.user) and only acts on routes carrying @RequirePermission.
    { provide: APP_GUARD, useClass: PermissionsGuard },
    // Global audit net. Registered BEFORE TenantTxInterceptor so it is the
    // OUTERMOST interceptor: its logging runs outside the request's tenant
    // transaction and writes on its own connection, so an audit entry persists
    // even when the request rolls back (denied/failed actions). Auto-captures
    // every mutation + sensitive read across all controllers.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    // Per-request tenant transaction: opens one explicit transaction per
    // authenticated request, sets the tenant GUC (SET LOCAL), routes all
    // queries onto it, and commits/rolls back deterministically. Feeds the
    // Postgres RLS policies and makes multi-write requests atomic. SSE opts out
    // via @SkipTenantTx(). Runs after the guards (needs req.user).
    { provide: APP_INTERCEPTOR, useClass: TenantTxInterceptor },
    // Patches createQueryRunner for per-request tenant routing and installs the
    // fail-open RLS policies at boot.
    RlsService,
    SeederService,
    DemoSeederService,
  ],
})
export class AppModule {}
