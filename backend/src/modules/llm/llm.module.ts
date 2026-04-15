import { Module } from '@nestjs/common';
import { LLM_PROVIDER_ADAPTERS } from './llm.constants';
import { LlmService } from './llm.service';
import { OpenAiLlmProvider } from './providers/openai-llm.provider';

@Module({
  providers: [
    OpenAiLlmProvider,
    {
      provide: LLM_PROVIDER_ADAPTERS,
      useFactory: (openAiProvider: OpenAiLlmProvider) => [openAiProvider],
      inject: [OpenAiLlmProvider],
    },
    LlmService,
  ],
  exports: [LlmService],
})
export class LlmModule {}
