import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText, type LanguageModel } from 'ai';
import type { LlmProviderAdapter } from '../interfaces/llm-provider.interface';
import type {
  LlmMessage,
  LlmModelConfig,
  LlmStreamOptions,
} from '../llm.types';

@Injectable()
export class OpenAiLlmProvider implements LlmProviderAdapter {
  readonly name = 'openai' as const;

  constructor(private readonly configService: ConfigService) {}

  getChatModel(config: LlmModelConfig): LanguageModel {
    const openai = createOpenAI({
      apiKey: config.apiKey ?? this.configService.get<string>('OPENAI_API_KEY'),
      baseURL:
        config.baseURL ?? this.configService.get<string>('OPENAI_BASE_URL'),
    });

    return openai(config.model);
  }

  async *streamText(
    messages: LlmMessage[],
    config: LlmModelConfig,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string> {
    const result = streamText({
      model: this.getChatModel(config),
      messages,
      temperature: options?.temperature,
      abortSignal: options?.abortSignal,
    });

    for await (const chunk of result.textStream) {
      yield chunk;
    }
  }
}
