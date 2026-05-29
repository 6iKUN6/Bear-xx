import { Module } from '@nestjs/common';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { LlmService } from './llm.service';
import { LlmChatModelFactory } from './providers/chat-model.factory';

@Module({
  providers: [LlmChatModelFactory, LlmModelRegistryService, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
