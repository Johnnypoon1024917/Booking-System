import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntry } from './audit.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';

// @Global so every controller can inject AuditService without each
// feature module having to import AuditModule explicitly.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditEntry])],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
