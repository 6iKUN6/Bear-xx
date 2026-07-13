import { Module } from '@nestjs/common';
import { ConversationTraceService } from './conversation-trace.service';

@Module({
  providers: [ConversationTraceService],
  exports: [ConversationTraceService],
})
export class ConversationTraceModule {}
