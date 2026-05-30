import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Visit } from './visit.entity';
import { VisitorsService } from './visitors.service';
import { VisitorsLifecycleController, VisitorsAdminController } from './visitors.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Visit])],
  controllers: [VisitorsLifecycleController, VisitorsAdminController],
  providers: [VisitorsService],
  exports: [VisitorsService],
})
export class VisitorsModule {}
