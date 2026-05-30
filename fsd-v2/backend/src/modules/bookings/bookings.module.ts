import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from './booking.entity';
import { Recurrence } from './recurrence.entity';
import { Holiday } from '../holidays/holiday.entity';
import { BookingsService } from './bookings.service';
import { BookingValidatorService } from './booking-validator.service';
import { RecurrenceService } from './recurrence.service';
import { CheckinService } from './checkin.service';
import { AutoReleaseService } from './auto-release.service';
import { FreeBusyService } from './freebusy.service';
import { IcsService } from './ics.service';
import {
  BookingsController, CheckinPublicController, IcsController, AdminBookingsController,
} from './bookings.controller';
import { ResourcesModule } from '../resources/resources.module';
import { AuditModule } from '../audit/audit.module';
import { SyncOutboxModule } from '../sync-outbox/sync-outbox.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { CustomizationModule } from '../customization/customization.module';
// Direct entity imports for the ICS feed (needs to read tenant + user
// outside the usual per-module repo wiring).
import { Tenant } from '../tenants/tenant.entity';
import { User } from '../users/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, Recurrence, Tenant, User, Holiday]),
    ResourcesModule,
    AuditModule,
    // Durable calendar-sync queue: BookingsService enqueues a sync row on
    // every create/update/cancel; the outbox worker retries the Outlook +
    // Google push with backoff so a transient outage never drops the event.
    SyncOutboxModule,
    // Email notification outbox: enqueued fire-and-forget on every
    // create/update/cancel alongside the calendar sync.
    NotificationsModule,
    // Tenant timezone for projecting booking instants back to local wall-clock
    // when enforcing per-resource operating hours.
    CustomizationModule,
  ],
  controllers: [BookingsController, AdminBookingsController, CheckinPublicController, IcsController],
  providers: [
    BookingsService,
    BookingValidatorService,
    RecurrenceService,
    CheckinService,
    AutoReleaseService,
    FreeBusyService,
    IcsService,
  ],
  // TypeOrmModule re-export lets downstream modules (InvoicesModule)
  // inject Booking/User repositories without re-registering the feature.
  exports: [BookingsService, TypeOrmModule],
})
export class BookingsModule {}
