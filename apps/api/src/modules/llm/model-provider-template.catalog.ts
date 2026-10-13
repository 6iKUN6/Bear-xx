import { BadRequestException } from '@nestjs/common';
import type { LlmUpstreamFormat } from './llm.types';

/** 供应商模板中推荐的模型。 */
export interface ModelProviderRecommendedModel {
  model: string;
  name: string;
  upstreamFormat: LlmUpstreamFormat;
  /** 默认运行预算；未公开的值保持为空，来源见 MODEL_PRESET_TOKEN_LIMITS.md。 */
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
}

/** 服务端内置的供应商连接模板。 */
export interface ModelProviderTemplate {
  providerKey: string;
  name: string;
  defaultBaseURL: string | null;
  defaultUpstreamFormat: LlmUpstreamFormat;
  allowedUpstreamFormats: readonly LlmUpstreamFormat[];
  recommendedModels: readonly ModelProviderRecommendedModel[];
}

/**
 * 内置模型供应商模板目录
 * @description 模板是 providerKey、默认 URL 与协议闭集的唯一事实源；Admin 只消费安全投影，
 * Logo 则按 providerKey 映射到本地静态资源。
 */
export const MODEL_PROVIDER_TEMPLATES: readonly ModelProviderTemplate[] = [
  {
    providerKey: 'openai',
    name: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    defaultUpstreamFormat: 'openai_responses',
    allowedUpstreamFormats: ['openai_responses', 'openai_chat_completions'],
    recommendedModels: [
      {
        model: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        upstreamFormat: 'openai_responses',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
      },
      {
        model: 'gpt-5.6-terra',
        name: 'GPT-5.6 Terra',
        upstreamFormat: 'openai_responses',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
      },
      {
        model: 'gpt-5.6-luna',
        name: 'GPT-5.6 Luna',
        upstreamFormat: 'openai_responses',
        contextWindowTokens: 1050000,
        maxOutputTokens: 128000,
      },
    ],
  },
  {
    providerKey: 'anthropic',
    name: 'Anthropic',
    defaultBaseURL: 'https://api.anthropic.com',
    defaultUpstreamFormat: 'anthropic_messages',
    allowedUpstreamFormats: ['anthropic_messages'],
    recommendedModels: [
      {
        model: 'claude-fable-5-1',
        name: 'Claude Fable 5.1',
        upstreamFormat: 'anthropic_messages',
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
      },
      {
        model: 'claude-opus-5',
        name: 'Claude Opus 5',
        upstreamFormat: 'anthropic_messages',
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
      },
      {
        model: 'claude-sonnet-5',
        name: 'Claude Sonnet 5',
        upstreamFormat: 'anthropic_messages',
        contextWindowTokens: 1000000,
        maxOutputTokens: 128000,
      },
      {
        model: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        upstreamFormat: 'anthropic_messages',
        contextWindowTokens: 200000,
        maxOutputTokens: 64000,
      },
    ],
  },
  {
    providerKey: 'deepseek',
    name: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'deepseek-v4-pro',
        name: 'DeepSeek V4 Pro',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1048576,
        maxOutputTokens: 393216,
      },
      {
        model: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1048576,
        maxOutputTokens: 384000,
      },
    ],
  },
  {
    providerKey: 'kimi',
    name: 'Kimi',
    defaultBaseURL: 'https://api.moonshot.cn/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'kimi-k3',
        name: 'Kimi K3（1M）',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1048576,
        maxOutputTokens: 131072,
      },
      {
        model: 'kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
      },
      {
        model: 'kimi-k2.7-code-highspeed',
        name: 'Kimi K2.7 Code Highspeed',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
      },
      {
        model: 'kimi-k2.6',
        name: 'Kimi K2.6',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
      },
    ],
  },
  {
    providerKey: 'kimi-coding',
    name: 'Kimi 编程套餐',
    defaultBaseURL: 'https://api.kimi.com/coding/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'k3',
        name: 'Kimi K3',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1048576,
        maxOutputTokens: 131072,
      },
      {
        model: 'k3-256k',
        name: 'Kimi K3（256K）',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: null,
      },
      {
        model: 'kimi-for-coding',
        name: 'Kimi K2.7 Code',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
      },
      {
        model: 'kimi-for-coding-highspeed',
        name: 'Kimi K2.7 Code Highspeed',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 262144,
        maxOutputTokens: 32768,
      },
    ],
  },
  {
    providerKey: 'doubao',
    name: '豆包',
    defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'doubao-seed-evolving',
        name: '豆包 Seed Evolving',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
      {
        model: 'doubao-seed-2-1-pro-260628',
        name: '豆包 Seed 2.1 Pro',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
      {
        model: 'doubao-seed-2-1-turbo-260628',
        name: '豆包 Seed 2.1 Turbo',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: null,
        maxOutputTokens: null,
      },
    ],
  },
  {
    providerKey: 'google',
    name: 'Google Gemini',
    defaultBaseURL: 'https://generativelanguage.googleapis.com',
    defaultUpstreamFormat: 'gemini_generate_content',
    allowedUpstreamFormats: ['gemini_generate_content'],
    recommendedModels: [
      {
        model: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        upstreamFormat: 'gemini_generate_content',
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        model: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash Preview',
        upstreamFormat: 'gemini_generate_content',
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        model: 'gemini-2.5-pro',
        name: 'Gemini 2.5 Pro',
        upstreamFormat: 'gemini_generate_content',
        contextWindowTokens: 1048576,
        maxOutputTokens: 65536,
      },
      {
        model: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        upstreamFormat: 'gemini_generate_content',
        contextWindowTokens: 1048576,
        maxOutputTokens: 65535,
      },
    ],
  },
  {
    providerKey: 'qwen',
    name: '通义千问',
    defaultBaseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'qwen3.8-max',
        name: 'Qwen 3.8 Max',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
      },
      {
        model: 'qwen3.8-flash',
        name: 'Qwen 3.8 Flash',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
      },
      {
        model: 'qwen3.7-plus',
        name: 'Qwen 3.7 Plus',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
      },
    ],
  },
  {
    providerKey: 'zhipu',
    name: '智谱 GLM',
    defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'glm-5.3',
        name: 'GLM 5.3',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
      },
      {
        model: 'glm-5.3-flash',
        name: 'GLM 5.3 Flash',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1000000,
        maxOutputTokens: 131072,
      },
    ],
  },
  {
    providerKey: 'minimax',
    name: 'MiniMax',
    defaultBaseURL: 'https://api.minimax.io/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [
      {
        model: 'MiniMax-M3',
        name: 'MiniMax M3',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 1048576,
        maxOutputTokens: 512000,
      },
      {
        model: 'MiniMax-M2.7',
        name: 'MiniMax M2.7',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 204800,
        maxOutputTokens: 131072,
      },
      {
        model: 'MiniMax-M2.7-highspeed',
        name: 'MiniMax M2.7 Highspeed',
        upstreamFormat: 'openai_chat_completions',
        contextWindowTokens: 204800,
        maxOutputTokens: 131072,
      },
    ],
  },
  {
    providerKey: 'openrouter',
    name: 'OpenRouter',
    defaultBaseURL: 'https://openrouter.ai/api/v1',
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [],
  },
  {
    providerKey: 'custom-openai',
    name: '自定义 OpenAI 兼容服务',
    defaultBaseURL: null,
    defaultUpstreamFormat: 'openai_chat_completions',
    allowedUpstreamFormats: ['openai_chat_completions'],
    recommendedModels: [],
  },
] as const;

/**
 * 查找并校验供应商模板
 * @param providerKey 待解析的供应商模板标识
 * @returns 返回闭集中的供应商模板
 * @description 不接受未知 providerKey，避免前端手写标签绕过协议范围和 Logo 映射。
 */
export function requireModelProviderTemplate(
  providerKey: string,
): ModelProviderTemplate {
  const template = MODEL_PROVIDER_TEMPLATES.find(
    (item) => item.providerKey === providerKey,
  );
  if (!template) {
    throw new BadRequestException(`不支持的模型供应商：${providerKey}`);
  }
  return template;
}

/**
 * 校验供应商模板是否允许指定上游协议
 * @param providerKey 供应商模板标识
 * @param upstreamFormat 模型声明的上游协议
 * @returns 无返回值，协议不受支持时抛出参数错误
 * @description 协议闭集由服务端模板负责，前端隐藏选项不能替代服务端校验。
 */
export function assertProviderAllowsUpstreamFormat(
  providerKey: string,
  upstreamFormat: LlmUpstreamFormat,
): void {
  const template = requireModelProviderTemplate(providerKey);
  if (!template.allowedUpstreamFormats.includes(upstreamFormat)) {
    throw new BadRequestException(
      `供应商「${template.name}」不支持上游协议 ${upstreamFormat}`,
    );
  }
}

/**
 * 规范化供应商连接根地址
 * @param value 管理员填写的 baseURL
 * @returns 返回移除末尾斜杠后的 HTTP(S) 根地址
 * @description baseURL 交给 SDK 追加资源路径；若管理员误填完整的完整请求端点，继续保存会在
 * 运行时形成重复路径，因此在控制面直接拒绝。
 */
export function normalizeModelProviderBaseUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new BadRequestException('baseURL 必须是有效的 HTTP(S) 地址');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('baseURL 只支持 http 或 https 协议');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new BadRequestException('baseURL 不能包含账号、密码、查询参数或片段');
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (/(?:\/chat\/completions|\/responses|\/messages)$/i.test(normalizedPath)) {
    throw new BadRequestException(
      'baseURL 应填写 API 根地址，不要包含 /chat/completions、/responses 或 /messages',
    );
  }
  url.pathname = normalizedPath;
  return url.toString().replace(/\/$/, '');
}

/**
 * 为新建模型补齐模板默认预算
 * @param providerKey 供应商模板标识
 * @param input 待创建模型及显式预算
 * @returns 合并后的创建参数，显式值（含 null）保持不变
 * @description 只按精确模型 ID 匹配；未知型号不猜测，不用于更新已有预设。
 */
export function applyModelTokenDefaults<
  T extends {
    model: string;
    contextWindowTokens?: number | null;
    maxOutputTokens?: number | null;
  },
>(
  providerKey: string,
  input: T,
): T & {
  contextWindowTokens: number | null;
  maxOutputTokens: number | null;
} {
  const model = requireModelProviderTemplate(
    providerKey,
  ).recommendedModels.find((item) => item.model === input.model.trim());
  return {
    ...input,
    contextWindowTokens:
      input.contextWindowTokens === undefined
        ? (model?.contextWindowTokens ?? null)
        : input.contextWindowTokens,
    maxOutputTokens:
      input.maxOutputTokens === undefined
        ? (model?.maxOutputTokens ?? null)
        : input.maxOutputTokens,
  };
}
