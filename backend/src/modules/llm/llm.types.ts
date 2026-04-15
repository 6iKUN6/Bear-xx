export type LlmProviderName = 'openai';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmModelConfig {
  provider: LlmProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export interface LlmStreamOptions {
  temperature?: number;
  abortSignal?: AbortSignal;
}
