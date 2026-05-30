import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GoogleSyncRecord } from './google-sync.entity';
import { GoogleSyncService } from './google-sync.service';
import { Booking } from '../bookings/booking.entity';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GoogleSyncRecord, Booking]),
    IntegrationsModule,
  ],
  providers: [GoogleSyncService],
  exports: [GoogleSyncService],
})
export class GoogleSyncModule {}
