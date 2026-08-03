import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { ChatContextService } from './chat-context.service';
import { ConversationSummaryService } from './conversation-summary.service';
import { ConversationTitleService } from './conversation-title.service';

@Module({
  imports: [LlmModule],
  providers: [
    ConversationSummaryService,
    ConversationTitleService,
    ChatContextService,
  ],
  exports: [
    ConversationSummaryService,
    ConversationTitleService,
    ChatContextService,
  ],
})
export class MemoryModule {}
