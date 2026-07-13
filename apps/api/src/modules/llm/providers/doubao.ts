import type { LlmModelPreset } from '../llm.types';
import { createOpenAiCompatibleModelPreset } from './openai-compatible-model-preset';

export const DOUBAO_PLATFORM = 'doubao';
export const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export enum DoubaoChatModel {
  DOUBAO_SEED_1_6 = 'doubao-seed-1-6',
}

export interface CreateDoubaoModelPresetOptions {
  id?: string;
  model: DoubaoChatModel | string;
  apiKey?: string;
  baseURL?: string;
  enabled?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
}

/**
 * 创建豆包模型预设
 * @param options 豆包模型预设创建参数
 * @returns 返回可注册到 LLM 模型注册表中的豆包模型预设对象
 * @description 用统一的 OpenAI 兼容协议模型预设工厂封装豆包模型配置，调用方只需要传入模型名和可选生成参数，无需重复声明 provider 与平台信息。
 */
export function createDoubaoModelPreset(
  options: CreateDoubaoModelPresetOptions,
): LlmModelPreset {
  return createOpenAiCompatibleModelPreset({
    id: options.id,
    platform: DOUBAO_PLATFORM,
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? DOUBAO_BASE_URL,
    enabled: options.enabled,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
    topP: options.topP,
  });
}
