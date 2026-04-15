import type { LanguageModel } from 'ai';
import type {
  LlmMessage,
  LlmModelConfig,
  LlmProviderName,
  LlmStreamOptions,
} from '../llm.types';

export interface LlmProviderAdapter {
  readonly name: LlmProviderName;
  getChatModel(config: LlmModelConfig): LanguageModel;
  streamText(
    messages: LlmMessage[],
    config: LlmModelConfig,
    options?: LlmStreamOptions,
  ): AsyncGenerator<string>;
}
