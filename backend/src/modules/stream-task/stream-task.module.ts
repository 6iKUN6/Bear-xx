import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationModule } from '../conversation/conversation.module';
import { MemoryModule } from '../memory/memory.module';
import { StreamTaskController } from './stream-task.controller';
import { StreamTaskRegistry } from './stream-task.registry';
import { StreamTaskService } from './stream-task.service';

@Module({
  imports: [AiModule, ConversationModule, MemoryModule],
  controllers: [StreamTaskController],
  providers: [StreamTaskService, StreamTaskRegistry],
  exports: [StreamTaskService],
})
export class StreamTaskModule {}
