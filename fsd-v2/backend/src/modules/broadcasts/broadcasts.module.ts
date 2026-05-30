import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Broadcast } from './broadcast.entity';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastsAdminController, BroadcastsPublicController } from './broadcasts.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Broadcast])],
  controllers: [BroadcastsPublicController, BroadcastsAdminController],
  providers: [BroadcastsService],
  exports: [BroadcastsService],
})
export class BroadcastsModule {}
