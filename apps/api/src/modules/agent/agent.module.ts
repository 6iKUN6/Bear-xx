import { Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentDefinitionService } from './agent-definition.service';
import { AgentController } from './agent.controller';
import { AgentAccessModule } from '../agent-access/agent-access.module';
import { LlmModule } from '../llm/llm.module';

@Module({
  imports: [AgentAccessModule, LlmModule],
  controllers: [AgentController],
  providers: [AgentService, AgentDefinitionService],
  exports: [AgentDefinitionService, AgentService],
})
export class AgentModule {}
