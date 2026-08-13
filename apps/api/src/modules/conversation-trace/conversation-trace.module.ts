import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ConversationTraceService } from './conversation-trace.service';

@Module({
  imports: [AiModule],
  providers: [ConversationTraceService],
  exports: [ConversationTraceService],
})
export class ConversationTraceModule {}
