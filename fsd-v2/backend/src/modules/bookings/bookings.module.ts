import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from './booking.entity';
import { Recurrence } from './recurrence.entity';
import { BookingsService } from './bookings.service';
import { RecurrenceService } from './recurrence.service';
import { CheckinService } from './checkin.service';
import { AutoReleaseService } from './auto-release.service';
import { FreeBusyService } from './freebusy.service';
import { IcsService } from './ics.service';
import {
  BookingsController, CheckinPublicController, IcsController,
} from './bookings.controller';
import { ResourcesModule } from '../resources/resources.module';
import { AuditModule } from '../audit/audit.module';
import { OutlookSyncModule } from '../outlook-sync/outlook-sync.module';
import { GoogleSyncModule } from '../google-sync/google-sync.module';
import { NotificationsModule } from '../notifications/notifications.module';
// Direct entity imports for the ICS feed (needs to read tenant + user
// outside the usual per-module repo wiring).
import { Tenant } from '../tenants/tenant.entity';
import { User } from '../users/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Booking, Recurrence, Tenant, User]),
    ResourcesModule,
    AuditModule,
    // Calendar sync hooks: BookingsService fire-and-forget calls these
    // on every create/update/cancel.
    OutlookSyncModule,
    GoogleSyncModule,
    // Email notification outbox: enqueued fire-and-forget on every
    // create/update/cancel alongside the calendar sync.
    NotificationsModule,
  ],
  controllers: [BookingsController, CheckinPublicController, IcsController],
  providers: [
    BookingsService,
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
