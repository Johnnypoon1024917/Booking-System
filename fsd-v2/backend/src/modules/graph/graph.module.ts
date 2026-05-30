import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphSubscription } from './graph-subscription.entity';
import { GraphService } from './graph.service';
import { GraphController } from './graph.controller';
import { IntegrationsModule } from '../integrations/integrations.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([GraphSubscription]),
    forwardRef(() => IntegrationsModule),
  ],
  controllers: [GraphController],
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
