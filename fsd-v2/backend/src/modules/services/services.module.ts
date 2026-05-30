import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Service, BookingService } from './service.entity';
import { ServicesService } from './services.service';
import {
  ServicesPublicController, BookingServicesController, ServicesAdminController,
} from './services.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Service, BookingService])],
  controllers: [ServicesPublicController, BookingServicesController, ServicesAdminController],
  providers: [ServicesService],
  exports: [ServicesService, TypeOrmModule],
})
export class ServicesModule {}
