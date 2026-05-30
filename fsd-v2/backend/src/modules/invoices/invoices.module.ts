import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invoice } from './invoice.entity';
import { InvoicesService } from './invoices.service';
import { InvoicesAdminController } from './invoices.controller';
import { ServicesModule } from '../services/services.module';
import { BookingsModule } from '../bookings/bookings.module';

@Module({
  // ServicesModule and BookingsModule export TypeOrmModule for their
  // entities; we re-import here so the rollup query has access to
  // BookingService and Booking repositories without re-registering them.
  imports: [
    TypeOrmModule.forFeature([Invoice]),
    ServicesModule,
    BookingsModule,
  ],
  controllers: [InvoicesAdminController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
