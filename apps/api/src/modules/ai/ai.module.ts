import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { AgentModule } from '../agent/agent.module';
import { ImagesModule } from '../images/images.module';
import {
  AgentCheckpointerService,
  CommonChatAgentFactory,
  CommonChatAgentLoopService,
  CommonChatAgentRunnerService,
  CommonChatAgentService,
} from './agents/common-chat-agent';
import {
  AgentLoopRunnerService,
  CapabilityRegistry,
  CapabilityResolver,
  CommonReactGraph,
  DirectAnswerGraph,
  HeuristicStepEvaluator,
  HybridPlanReactGraph,
  PlanExecuteGraph,
  PlanGraphRunner,
  PlannerService,
  STEP_EVALUATOR,
  StrategyRegistryService,
  StrategyRouterService,
} from './agent-loop';
import { AiService } from './ai.service';
import { McpModule } from './mcp/mcp.module';
import { McDonaldsOrderModule } from '../mcdonalds-order/mcdonalds-order.module';
import { McDonaldsCredentialModule } from '../mcdonalds-credential/mcdonalds-credential.module';

@Module({
  imports: [
    LlmModule,
    MemoryModule,
    AgentModule,
    ImagesModule,
    McpModule,
    McDonaldsCredentialModule,
    McDonaldsOrderModule,
  ],
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
    PlanGraphRunner,
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
