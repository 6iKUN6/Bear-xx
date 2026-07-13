import type { LlmGenerationConfig, LlmModelPreset } from '../llm.types';

export interface CreateOpenAiCompatibleModelPresetOptions extends LlmGenerationConfig {
  id?: string;
  platform: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
}

/**
 * 创建 OpenAI 兼容模型预设
 * @param options 模型预设创建参数
 * @returns 返回可注册到 LLM 模型注册表中的模型预设对象
 * @description 统一封装 OpenAI 兼容协议模型的预设结构，供豆包、DeepSeek、Kimi 等供应商复用，避免重复拼装 provider、platform、baseURL 和默认生成参数。
 */
export function createOpenAiCompatibleModelPreset(
  options: CreateOpenAiCompatibleModelPresetOptions,
): LlmModelPreset {
  return {
    id: options.id ?? `${options.platform}:${options.model}`,
    provider: 'openai',
    platform: options.platform,
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    enabled: options.enabled,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    topP: options.topP,
  };
}
