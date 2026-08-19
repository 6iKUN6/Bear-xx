import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationTraceModule } from '../conversation-trace';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { StreamTaskModule } from '../stream-task/stream-task.module';
import { AgentFlowApprovalService } from './agent-flow-approval.service';
import { AgentFlowTaskEventService } from './agent-flow-task-event.service';
import { AgentFlowController } from './agent-flow.controller';
import { AgentFlowService } from './agent-flow.service';
import { AgentFlowVersionService } from './agent-flow-version.service';
import { FlowCompiler } from './runtime/flow-compiler.service';
import { FlowRuntimeValidator } from './runtime/flow-runtime-validator.service';
import { FlowTemplateRegistry } from './runtime/flow-template.registry';
import { AgentFlowActivities } from './temporal/agent-flow.activities';
import { TemporalClientService } from './temporal/temporal-client.service';
import { AgentFlowSignalOutboxService } from './temporal/agent-flow-signal-outbox.service';
import { AgentFlowCancellationDispatcherService } from './temporal/agent-flow-cancellation-dispatcher.service';

@Module({
  imports: [
    AiModule,
    LlmModule,
    MemoryModule,
    ConversationTraceModule,
    forwardRef(() => StreamTaskModule),
  ],
  controllers: [AgentFlowController],
  providers: [
    AgentFlowService,
    AgentFlowVersionService,
    AgentFlowApprovalService,
    AgentFlowTaskEventService,
    FlowRuntimeValidator,
    FlowCompiler,
    FlowTemplateRegistry,
    AgentFlowActivities,
    TemporalClientService,
    AgentFlowSignalOutboxService,
    AgentFlowCancellationDispatcherService,
  ],
  exports: [
    AgentFlowService,
    AgentFlowVersionService,
    AgentFlowApprovalService,
    AgentFlowTaskEventService,
    FlowRuntimeValidator,
    FlowCompiler,
    FlowTemplateRegistry,
    AgentFlowActivities,
    TemporalClientService,
    AgentFlowSignalOutboxService,
    AgentFlowCancellationDispatcherService,
  ],
})
export class AgentFlowModule {}
