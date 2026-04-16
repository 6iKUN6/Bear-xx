import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ChatContextService } from './chat-context.service';
import { ConversationSummaryService } from './conversation-summary.service';

@Module({
  imports: [LlmModule],
  providers: [ConversationSummaryService, ChatContextService],
  exports: [ConversationSummaryService, ChatContextService],
})
export class MemoryModule {}
