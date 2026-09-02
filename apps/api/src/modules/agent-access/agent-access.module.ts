import { Module } from '@nestjs/common';
import { AgentAccessService } from './agent-access.service';

@Module({
  providers: [AgentAccessService],
  exports: [AgentAccessService],
})
export class AgentAccessModule {}
