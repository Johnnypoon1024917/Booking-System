import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutlookSyncRecord } from './outlook-sync.entity';
import { OutlookSyncService } from './outlook-sync.service';
import { Booking } from '../bookings/booking.entity';
import { Resource } from '../resources/resource.entity';
import { IntegrationsModule } from '../integrations/integrations.module';
import { GraphModule } from '../graph/graph.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([OutlookSyncRecord, Booking, Resource]),
    IntegrationsModule,
    GraphModule,
  ],
  providers: [OutlookSyncService],
  exports: [OutlookSyncService],
})
export class OutlookSyncModule {}
