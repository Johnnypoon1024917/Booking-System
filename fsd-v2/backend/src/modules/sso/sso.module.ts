import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdentityProvider, SsoState } from './identity-provider.entity';
import { SsoService } from './sso.service';
import { SsoController } from './sso.controller';
import { User } from '../users/user.entity';
import { Tenant } from '../tenants/tenant.entity';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([IdentityProvider, SsoState, User, Tenant]),
    AuthModule,
  ],
  providers: [SsoService],
  controllers: [SsoController],
  exports: [SsoService],
})
export class SsoModule {}
