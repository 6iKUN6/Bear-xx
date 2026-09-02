import { forwardRef, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { AgentFlowModule } from '../agent-flow/agent-flow.module';
import { ConversationModule } from '../conversation/conversation.module';
import { ConversationTraceModule } from '../conversation-trace';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { McDonaldsOrderModule } from '../mcdonalds-order/mcdonalds-order.module';
import { McDonaldsCredentialModule } from '../mcdonalds-credential/mcdonalds-credential.module';
import { StreamTaskController } from './stream-task.controller';
import { StreamTaskRegistry } from './stream-task.registry';
import { StreamTaskSnapshotService } from './stream-task-snapshot.service';
import { FlowTaskDispatcherService } from './flow-task-dispatcher.service';
import { StreamTaskService } from './stream-task.service';
import { AgentAccessModule } from '../agent-access/agent-access.module';

@Module({
  imports: [
    AiModule,
    forwardRef(() => AgentFlowModule),
    ConversationModule,
    ConversationTraceModule,
    LlmModule,
    MemoryModule,
    McDonaldsOrderModule,
    McDonaldsCredentialModule,
    AgentAccessModule,
  ],
  controllers: [StreamTaskController],
  providers: [
    StreamTaskService,
    StreamTaskRegistry,
    StreamTaskSnapshotService,
    FlowTaskDispatcherService,
  ],
  exports: [StreamTaskService, StreamTaskRegistry, StreamTaskSnapshotService],
})
export class StreamTaskModule {}
