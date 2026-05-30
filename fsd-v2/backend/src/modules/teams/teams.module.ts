import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BotConversationRef } from './teams.entity';
import { TeamsService } from './teams.service';
import { TeamsController, AdminTeamsController } from './teams.controller';

@Module({
  imports: [TypeOrmModule.forFeature([BotConversationRef])],
  controllers: [TeamsController, AdminTeamsController],
  providers: [TeamsService],
  exports: [TeamsService],
})
export class TeamsModule {}
