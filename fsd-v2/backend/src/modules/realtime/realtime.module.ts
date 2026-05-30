import { Global, Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeController } from './realtime.controller';

// @Global so any feature module can inject RealtimeGateway without
// importing RealtimeModule — emit() is a cross-cutting concern.
@Global()
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
