import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import {
  CommonChatAgentRunnerService,
  CommonChatAgentService,
} from './agents/common-chat-agent';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule, MemoryModule],
  providers: [AiService, CommonChatAgentService, CommonChatAgentRunnerService],
  exports: [AiService, CommonChatAgentService, CommonChatAgentRunnerService],
})
export class AiModule {}
