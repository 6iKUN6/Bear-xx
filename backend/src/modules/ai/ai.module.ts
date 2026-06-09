import { Module } from '@nestjs/common';
import { LlmModule } from '../llm/llm.module';
import { MemoryModule } from '../memory/memory.module';
import {
  CommonChatAgentFactory,
  CommonChatAgentLoopService,
  CommonChatAgentRunnerService,
  CommonChatAgentService,
} from './agents/common-chat-agent';
import { AiService } from './ai.service';

@Module({
  imports: [LlmModule, MemoryModule],
  providers: [
    AiService,
    CommonChatAgentFactory,
    CommonChatAgentLoopService,
    CommonChatAgentService,
    CommonChatAgentRunnerService,
  ],
  exports: [
    AiService,
    CommonChatAgentFactory,
    CommonChatAgentLoopService,
    CommonChatAgentService,
    CommonChatAgentRunnerService,
  ],
})
export class AiModule {}
