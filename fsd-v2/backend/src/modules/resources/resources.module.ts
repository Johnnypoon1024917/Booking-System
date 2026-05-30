import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Resource } from './resource.entity';
import { ResourcesService } from './resources.service';
import { ResourcesPublicController, ResourcesAdminController } from './resources.controller';
import { CustomizationModule } from '../customization/customization.module';

@Module({
  imports: [TypeOrmModule.forFeature([Resource]), CustomizationModule],
  controllers: [ResourcesPublicController, ResourcesAdminController],
  providers: [ResourcesService],
  exports: [ResourcesService, TypeOrmModule],
})
export class ResourcesModule {}
