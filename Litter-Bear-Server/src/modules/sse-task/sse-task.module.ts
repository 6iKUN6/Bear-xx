import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';
import { SseTaskController } from './sse-task.controller';
import { SseTaskRegistry } from './sse-task.registry';
import { SseTaskService } from './sse-task.service';

@Module({
  imports: [AiModule, ConversationModule],
  controllers: [SseTaskController],
  providers: [SseTaskService, SseTaskRegistry],
  exports: [SseTaskService],
})
export class SseTaskModule {}
