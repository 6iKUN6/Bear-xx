import { ModelUpstreamFormat } from '@prisma/client';
import type { LlmProviderName, LlmUpstreamFormat } from './llm.types';

/** Prisma 枚举 → 运行时 wire 格式。 */
const FORMAT_BY_DB_VALUE: Record<ModelUpstreamFormat, LlmUpstreamFormat> = {
  [ModelUpstreamFormat.OPENAI_CHAT_COMPLETIONS]: 'openai_chat_completions',
  [ModelUpstreamFormat.OPENAI_RESPONSES]: 'openai_responses',
  [ModelUpstreamFormat.ANTHROPIC_MESSAGES]: 'anthropic_messages',
  [ModelUpstreamFormat.GEMINI_GENERATE_CONTENT]: 'gemini_generate_content',
};

/** 运行时 wire 格式 → Prisma 枚举。 */
const DB_VALUE_BY_FORMAT: Record<LlmUpstreamFormat, ModelUpstreamFormat> = {
  openai_chat_completions: ModelUpstreamFormat.OPENAI_CHAT_COMPLETIONS,
  openai_responses: ModelUpstreamFormat.OPENAI_RESPONSES,
  anthropic_messages: ModelUpstreamFormat.ANTHROPIC_MESSAGES,
  gemini_generate_content: ModelUpstreamFormat.GEMINI_GENERATE_CONTENT,
};

/** wire 格式 → SDK provider；provider 是派生值，不再单独存储。 */
const PROVIDER_BY_FORMAT: Record<LlmUpstreamFormat, LlmProviderName> = {
  openai_chat_completions: 'openai',
  openai_responses: 'openai',
  anthropic_messages: 'anthropic',
  gemini_generate_content: 'google',
};

/**
 * 把数据库枚举转换为运行时 wire 格式
 * @param value Prisma 的 ModelUpstreamFormat
 * @returns 返回运行时格式标识
 */
export function toUpstreamFormat(
  value: ModelUpstreamFormat,
): LlmUpstreamFormat {
  return FORMAT_BY_DB_VALUE[value];
}

/**
 * 把运行时 wire 格式转换为数据库枚举
 * @param value 运行时格式标识
 * @returns 返回可写入 Prisma 的枚举值
 */
export function toDbUpstreamFormat(
  value: LlmUpstreamFormat,
): ModelUpstreamFormat {
  return DB_VALUE_BY_FORMAT[value];
}

/**
 * 由 wire 格式推导 SDK provider
 * @param format 上游 wire 格式
 * @returns 返回应使用的 SDK
 * @description provider 与 format 是同一事实的两种说法，存两份必然漂移。以 format 为准
 * 单向推导，「anthropic SDK 发 Responses」这类非法组合从类型上就不可表达。
 */
export function toProviderName(format: LlmUpstreamFormat): LlmProviderName {
  return PROVIDER_BY_FORMAT[format];
}
