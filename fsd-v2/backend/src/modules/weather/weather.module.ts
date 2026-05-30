import { Module } from '@nestjs/common';
import { WeatherService } from './weather.service';
import { WeatherController } from './weather.controller';
import { HKOClient } from './hko.client';
import { CustomizationModule } from '../customization/customization.module';

@Module({
  imports: [CustomizationModule],
  controllers: [WeatherController],
  providers: [WeatherService, HKOClient],
  exports: [WeatherService],
})
export class WeatherModule {}
