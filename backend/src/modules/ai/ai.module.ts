import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { CommonChatAgentService } from './agents/common-chat-agent';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule],
  providers: [AiService, CommonChatAgentService],
  exports: [AiService, CommonChatAgentService],
})
export class AiModule {}
