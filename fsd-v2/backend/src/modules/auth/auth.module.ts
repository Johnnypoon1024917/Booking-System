import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { UsersModule } from '../users/users.module';
import { PushModule } from '../push/push.module';
import { PermissionsModule } from '../permissions/permissions.module';
import { Tenant } from '../tenants/tenant.entity';
import { prodSecret } from '../../common/env';

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.register({
      // No insecure literal fallback: in production a missing JWT_SECRET throws
      // at boot rather than signing tokens with a publicly-known default. The
      // JwtStrategy separately enforces the 32-char minimum on the verify side.
      secret: prodSecret('JWT_SECRET', 'dev-only-jwt-change-me-32-bytes-min'),
      signOptions: { expiresIn: process.env.JWT_TTL || '12h' },
    }),
    TypeOrmModule.forFeature([Tenant]),
    UsersModule,
    // Logout deletes the device's push subscription (shared-device privacy),
    // so the auth controller needs PushService.
    PushModule,
    // /auth/me resolves the caller's effective permission set for the SPA.
    PermissionsModule,
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService, JwtModule, PassportModule],
})
export class AuthModule {}
