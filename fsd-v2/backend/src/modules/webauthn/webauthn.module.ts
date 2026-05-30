import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WebauthnCredential, WebauthnChallenge } from './webauthn-credential.entity';
import { WebauthnService } from './webauthn.service';
import { WebauthnController } from './webauthn.controller';
import { User } from '../users/user.entity';
import { Tenant } from '../tenants/tenant.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([WebauthnCredential, WebauthnChallenge, User, Tenant]),
    AuthModule,
  ],
  providers: [WebauthnService],
  controllers: [WebauthnController],
  exports: [WebauthnService],
})
export class WebauthnModule {}
