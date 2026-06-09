import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Service, BookingService } from './service.entity';
import { Booking } from '../bookings/booking.entity';
import { ServicesService } from './services.service';
import {
  ServicesPublicController, BookingServicesController, ServicesAdminController,
} from './services.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Service, BookingService, Booking])],
  controllers: [ServicesPublicController, BookingServicesController, ServicesAdminController],
  providers: [ServicesService],
  exports: [ServicesService, TypeOrmModule],
})
export class ServicesModule {}
