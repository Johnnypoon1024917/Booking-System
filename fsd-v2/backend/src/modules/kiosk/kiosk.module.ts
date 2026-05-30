import { Module } from '@nestjs/common';
import { KioskService } from './kiosk.service';
import { KioskController } from './kiosk.controller';
import { ResourcesModule } from '../resources/resources.module';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  // Re-export-only — Resource and Booking repositories come from those
  // modules' TypeOrmModule re-exports.
  imports: [ResourcesModule, BookingsModule],
  controllers: [KioskController],
  providers: [KioskService],
})
export class KioskModule {}
