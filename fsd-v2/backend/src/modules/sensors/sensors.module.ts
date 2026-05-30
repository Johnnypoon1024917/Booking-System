import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sensor, SensorReading } from './sensor.entity';
import { SensorsService } from './sensors.service';
import { SensorsIngestController, SensorsAdminController } from './sensors.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Sensor, SensorReading])],
  controllers: [SensorsIngestController, SensorsAdminController],
  providers: [SensorsService],
  exports: [SensorsService],
})
export class SensorsModule {}
