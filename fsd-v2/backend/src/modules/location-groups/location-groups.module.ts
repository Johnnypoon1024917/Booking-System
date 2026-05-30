import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { LocationGroup } from './location-group.entity';
import { LocationGroupsService } from './location-groups.service';
import { LocationGroupsController } from './location-groups.controller';

@Module({
  imports: [TypeOrmModule.forFeature([LocationGroup])],
  controllers: [LocationGroupsController],
  providers: [LocationGroupsService],
  exports: [LocationGroupsService],
})
export class LocationGroupsModule {}
