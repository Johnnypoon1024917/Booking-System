import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '../users/user.entity';
import { Booking } from '../bookings/booking.entity';
import { AuditEntry } from '../audit/audit.entity';
import { DsarService } from './dsar.service';
import { DsarController } from './dsar.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User, Booking, AuditEntry])],
  controllers: [DsarController],
  providers: [DsarService],
})
export class DsarModule {}
