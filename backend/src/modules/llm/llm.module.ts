import { Module } from '@nestjs/common';
import { LlmModelRegistryService } from './llm-model-registry.service';
import { LlmService } from './llm.service';
import { OpenAiCompatibleLlmProvider } from './providers/openai-compatible-llm.provider';

@Module({
  providers: [OpenAiCompatibleLlmProvider, LlmModelRegistryService, LlmService],
  exports: [LlmService],
})
export class LlmModule {}
