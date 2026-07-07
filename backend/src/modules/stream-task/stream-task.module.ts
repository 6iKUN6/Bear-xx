import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';
import { ConversationTraceModule } from '../conversation-trace';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import { StreamTaskController } from './stream-task.controller';
import { StreamTaskRegistry } from './stream-task.registry';
import { StreamTaskSnapshotService } from './stream-task-snapshot.service';
import { StreamTaskService } from './stream-task.service';

@Module({
  imports: [
    AiModule,
    ConversationModule,
    ConversationTraceModule,
    LlmModule,
    MemoryModule,
  ],
  controllers: [StreamTaskController],
  providers: [StreamTaskService, StreamTaskRegistry, StreamTaskSnapshotService],
  exports: [StreamTaskService],
})
export class StreamTaskModule {}
