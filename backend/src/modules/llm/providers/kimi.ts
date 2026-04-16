import type { LlmModelPreset } from '../llm.types';
import { createOpenAiCompatibleModelPreset } from './openai-compatible-model-preset';

export const KIMI_PLATFORM = 'kimi';
export const KIMI_BASE_URL = 'https://api.moonshot.cn/v1';

export enum KimiChatModel {
  KIMI_K2 = 'kimi-k2-0711-preview',
}

export interface CreateKimiModelPresetOptions {
  id?: string;
  model: KimiChatModel | string;
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

/**
 * 创建 Kimi 模型预设
 * @param options Kimi 模型预设创建参数
 * @returns 返回可注册到 LLM 模型注册表中的 Kimi 模型预设对象
 * @description 用统一的 OpenAI 兼容协议模型预设工厂封装 Kimi 配置，调用方只需要传入模型名和可选生成参数，无需重复声明 provider 与平台信息。
 */
export function createKimiModelPreset(
  options: CreateKimiModelPresetOptions,
): LlmModelPreset {
  return createOpenAiCompatibleModelPreset({
    id: options.id,
    platform: KIMI_PLATFORM,
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? KIMI_BASE_URL,
    enabled: options.enabled,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    topP: options.topP,
  });
}
