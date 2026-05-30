import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FloorPlan } from './floor-plan.entity';
import { FloorPlansService } from './floor-plans.service';
import { FloorPlansPublicController, FloorPlansAdminController } from './floor-plans.controller';

@Module({
  imports: [TypeOrmModule.forFeature([FloorPlan])],
  controllers: [FloorPlansPublicController, FloorPlansAdminController],
  providers: [FloorPlansService],
  exports: [FloorPlansService],
})
export class FloorPlansModule {}
