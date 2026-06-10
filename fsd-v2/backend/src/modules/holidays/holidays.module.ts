import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Holiday } from './holiday.entity';
import { HolidaysService } from './holidays.service';
import { HolidaysAdminController } from './holidays.controller';
import { HolidaysCron } from './holidays.cron';
import { GovHKHolidayClient } from './govhk.client';
import { CustomizationModule } from '../customization/customization.module';

@Module({
  // RedisService is @Global (RedisModule) — no import needed for the cron lock.
  imports: [TypeOrmModule.forFeature([Holiday]), CustomizationModule],
  controllers: [HolidaysAdminController],
  providers: [HolidaysService, HolidaysCron, GovHKHolidayClient],
  exports: [HolidaysService],
})
export class HolidaysModule {}
