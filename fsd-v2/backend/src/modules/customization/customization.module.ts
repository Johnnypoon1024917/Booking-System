import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customization } from './customization.entity';
import { CustomizationService } from './customization.service';
import { CustomizationController } from './customization.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Customization])],
  controllers: [CustomizationController],
  providers: [CustomizationService],
  exports: [CustomizationService],
})
export class CustomizationModule {}
