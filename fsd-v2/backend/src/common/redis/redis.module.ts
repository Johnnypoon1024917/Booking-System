import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

// @Global so any module (realtime gateway, rate-limit guard, broadcasts) can
// inject RedisService without importing this module. There is exactly one
// shared backplane per process.
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
