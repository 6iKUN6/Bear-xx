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

export interface LlmModelPreset extends LlmModelConfig {
  id: string;
  platform: string;
  enabled?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

export interface LlmModelSelector {
  modelId?: string;
  provider?: string;
  platform?: string;
  model?: string;
}

export interface LlmGenerationConfig {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

export interface LlmTextRequest {
  model?: LlmModelSelector;
  generation?: LlmGenerationConfig;
}

export interface ResolvedLlmModelConfig extends LlmModelConfig {
  id: string;
  platform: string;
}

export interface ResolvedLlmTextRequest {
  model: ResolvedLlmModelConfig;
  generation: LlmGenerationConfig;
}

export interface LlmStreamOptions {
  abortSignal?: AbortSignal;
}
