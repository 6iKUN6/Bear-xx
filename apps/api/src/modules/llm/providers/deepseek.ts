import type { LlmModelPreset } from '../llm.types';
import { createOpenAiCompatibleModelPreset } from './openai-compatible-model-preset';

export const DEEPSEEK_PLATFORM = 'deepseek';
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';

export enum DeepseekChatModel {
  DEEPSEEK_CHAT = 'deepseek-chat',
}

export interface CreateDeepseekModelPresetOptions {
  id?: string;
  model: DeepseekChatModel | string;
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

/**
 * 创建 DeepSeek 模型预设
 * @param options DeepSeek 模型预设创建参数
 * @returns 返回可注册到 LLM 模型注册表中的 DeepSeek 模型预设对象
 * @description 用统一的 OpenAI 兼容协议模型预设工厂封装 DeepSeek 配置，调用方只需要传入模型名和可选生成参数，无需重复声明 provider 与平台信息。
 */
export function createDeepseekModelPreset(
  options: CreateDeepseekModelPresetOptions,
): LlmModelPreset {
  return createOpenAiCompatibleModelPreset({
    id: options.id,
    platform: DEEPSEEK_PLATFORM,
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? DEEPSEEK_BASE_URL,
    enabled: options.enabled,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    topP: options.topP,
  });
}
