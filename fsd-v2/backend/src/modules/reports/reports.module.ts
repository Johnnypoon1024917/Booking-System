import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Booking } from '../bookings/booking.entity';
import { AuditEntry } from '../audit/audit.entity';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Booking, AuditEntry])],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
