import type { LlmGenerationConfig, LlmModelPreset } from '../llm.types';

export const ANTHROPIC_PLATFORM = 'anthropic';

export enum AnthropicChatModel {
  CLAUDE_SONNET_4_5 = 'claude-sonnet-4-5-20250929',
}

export interface CreateAnthropicModelPresetOptions extends LlmGenerationConfig {
  id?: string;
  model: AnthropicChatModel | string;
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
}

/**
 * 创建 Anthropic 模型预设
 * @param options Anthropic 模型预设创建参数
 * @returns 返回可注册到 LLM 模型注册表中的 Anthropic 模型预设对象
 * @description 使用独立的 Anthropic provider 标记模型，避免把 Claude 错误路由到 OpenAI 兼容协议实现。
 */
export function createAnthropicModelPreset(
  options: CreateAnthropicModelPresetOptions,
): LlmModelPreset {
  return {
    id: options.id ?? `${ANTHROPIC_PLATFORM}:${options.model}`,
    provider: 'anthropic',
    platform: ANTHROPIC_PLATFORM,
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    enabled: options.enabled,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    topP: options.topP,
  };
}
