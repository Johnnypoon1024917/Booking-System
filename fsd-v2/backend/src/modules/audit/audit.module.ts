import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditEntry } from './audit.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditSubscriber } from './audit.subscriber';

// @Global so every controller can inject AuditService without each
// feature module having to import AuditModule explicitly.
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditEntry])],
  controllers: [AuditController],
  // AuditSubscriber self-registers on the DataSource at construction; listing it
  // as a provider is what makes Nest instantiate it. It captures the per-field
  // before/after diff for every entity create/update/delete.
  providers: [AuditService, AuditSubscriber],
  exports: [AuditService],
})
export class AuditModule {}
