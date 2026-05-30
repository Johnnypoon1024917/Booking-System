import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IntegrationCredential, RoomMailbox } from './credential.entity';
import { CredentialService } from './credential.service';
import { IntegrationsController } from './integrations.controller';
import { AuditModule } from '../audit/audit.module';
import { GraphModule } from '../graph/graph.module';

// Integrations is the root module for all external-system plumbing.
// CredentialService is exported so Graph / Outlook / Google / Teams /
// Webhooks can pull decrypted secrets without re-implementing the AES
// envelope.
@Module({
  imports: [
    TypeOrmModule.forFeature([IntegrationCredential, RoomMailbox]),
    AuditModule,
    forwardRef(() => GraphModule),
  ],
  controllers: [IntegrationsController],
  providers: [CredentialService],
  exports: [CredentialService],
})
export class IntegrationsModule {}
