import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { AgentModule } from '../agent/agent.module';
import {
  AgentCheckpointerService,
  CommonChatAgentFactory,
  CommonChatAgentLoopService,
  CommonChatAgentRunnerService,
  CommonChatAgentService,
} from './agents/common-chat-agent';
import {
  AgentLoopController,
  AgentLoopRunnerService,
  CapabilityRegistry,
  CapabilityResolver,
  CommonReactGraph,
  DirectAnswerGraph,
  HeuristicStepEvaluator,
  HybridPlanReactGraph,
  PlanExecuteGraph,
  PlannerService,
  STEP_EVALUATOR,
  StrategyRegistryService,
  StrategyRouterService,
} from './agent-loop';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule, MemoryModule, AgentModule],
  providers: [
    AiService,
    CommonChatAgentFactory,
    CommonChatAgentLoopService,
    CommonChatAgentService,
    CommonChatAgentRunnerService,
    AgentCheckpointerService,
    AgentLoopRunnerService,
    CapabilityRegistry,
    CapabilityResolver,
    PlannerService,
    AgentLoopController,
    { provide: STEP_EVALUATOR, useClass: HeuristicStepEvaluator },
    StrategyRouterService,
    StrategyRegistryService,
    DirectAnswerGraph,
    CommonReactGraph,
    PlanExecuteGraph,
    HybridPlanReactGraph,
  ],
  exports: [
    AiService,
    CapabilityRegistry,
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
