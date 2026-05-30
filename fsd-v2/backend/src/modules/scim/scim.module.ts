import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScimToken } from './scim-token.entity';
import { ScimService } from './scim.service';
import { ScimController } from './scim.controller';
import { ScimAdminController } from './scim-admin.controller';
import { User } from '../users/user.entity';
import { Department } from '../departments/department.entity';

@Module({
  imports: [TypeOrmModule.forFeature([ScimToken, User, Department])],
  providers: [ScimService],
  controllers: [ScimController, ScimAdminController],
  exports: [ScimService],
})
export class ScimModule {}
