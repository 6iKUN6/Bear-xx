import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import {
  CommonChatAgentFactory,
  CommonChatAgentLoopService,
  CommonChatAgentRunnerService,
  CommonChatAgentService,
} from './agents/common-chat-agent';
import {
  AgentLoopRunnerService,
  CommonReactGraph,
  DirectAnswerGraph,
  HybridPlanReactGraph,
  PlanExecuteGraph,
  StrategyRegistryService,
  StrategyRouterService,
} from './agent-loop';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule, MemoryModule],
  providers: [
    AiService,
    CommonChatAgentFactory,
    CommonChatAgentLoopService,
    CommonChatAgentService,
    CommonChatAgentRunnerService,
    AgentLoopRunnerService,
    StrategyRouterService,
    StrategyRegistryService,
    DirectAnswerGraph,
    CommonReactGraph,
    PlanExecuteGraph,
    HybridPlanReactGraph,
  ],
  exports: [
    AiService,
    CommonChatAgentFactory,
    CommonChatAgentLoopService,
    CommonChatAgentService,
    CommonChatAgentRunnerService,
    AgentLoopRunnerService,
    StrategyRouterService,
    StrategyRegistryService,
  ],
})
export class AiModule {}
