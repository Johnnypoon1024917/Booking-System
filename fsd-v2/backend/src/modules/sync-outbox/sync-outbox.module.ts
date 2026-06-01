import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SyncOutbox } from './sync-outbox.entity';
import { SyncOutboxService } from './sync-outbox.service';
import { Booking } from '../bookings/booking.entity';
import { OutlookSyncModule } from '../outlook-sync/outlook-sync.module';
import { GoogleSyncModule } from '../google-sync/google-sync.module';

// Durable calendar-sync queue. Wraps the Outlook + Google sync adapters with
// a persistent outbox + retry worker so booking changes reliably reach the
// external calendars even across transient provider outages.
@Module({
  imports: [
    TypeOrmModule.forFeature([SyncOutbox, Booking]),
    OutlookSyncModule,
    GoogleSyncModule,
  ],
  providers: [SyncOutboxService],
  exports: [SyncOutboxService],
})
export class SyncOutboxModule {}
