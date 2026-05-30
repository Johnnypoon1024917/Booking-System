import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PushSubscription } from './push-subscription.entity';
import { PushService } from './push.service';
import { PushAdminController, PushController } from './push.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PushSubscription])],
  controllers: [PushController, PushAdminController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
