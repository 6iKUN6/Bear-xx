import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentDefinitionService } from './agent-definition.service';
import { AgentController } from './agent.controller';

@Module({
  controllers: [AgentController],
  providers: [AgentService, AgentDefinitionService],
  exports: [AgentDefinitionService],
})
export class AgentModule {}
