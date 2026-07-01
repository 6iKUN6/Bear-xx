export type LlmProviderName = 'openai' | 'anthropic';

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
  temperature?: number; // 采样温度
  maxOutputTokens?: number; // 最大输出 token 数
  topP?: number; // Top P 采样参数
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

export interface LlmGenerateOptions {
  abortSignal?: AbortSignal;
}
