import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ResourceType } from './resource-type.entity';
import { ResourceTypesService } from './resource-types.service';
import { ResourceTypesPublicController, ResourceTypesAdminController } from './resource-types.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ResourceType])],
  controllers: [ResourceTypesPublicController, ResourceTypesAdminController],
  providers: [ResourceTypesService],
  exports: [ResourceTypesService],
})
export class ResourceTypesModule {}
