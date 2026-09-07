import type { ReasoningSelection } from '@litter-bear/types';

export type LlmProviderName = 'openai' | 'anthropic' | 'google';

/**
 * 上游 wire 格式闭集
 * @description 唯一决定用哪个 LangChain 客户端；provider 由它推导，不再单独配置。
 * 刻意不做 provider × format 的自由组合：那会产生「anthropic SDK 发 Responses」这类
 * 不存在的状态。合法的 (platform, format) 组合由连通性探针实测决定，不硬编码矩阵。
 */
export type LlmUpstreamFormat =
  | 'openai_chat_completions'
  | 'openai_responses'
  | 'anthropic_messages'
  | 'gemini_generate_content';

export interface LlmReasoningActivationCapability {
  values: readonly ('enabled' | 'disabled' | 'auto')[];
  defaultValue: 'enabled' | 'disabled' | 'auto';
  configurable: boolean;
}

export interface LlmReasoningEffortCapability {
  values: readonly ('minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max')[];
  defaultValue: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  configurable: boolean;
}

export interface LlmReasoningBudgetCapability {
  supportsAuto: boolean;
  minimum?: number;
  maximum?: number;
  lessThanMaxOutputTokens?: boolean;
  defaultValue: number | 'auto';
  configurable: boolean;
}

/** 可安全下发前端的模型思考能力投影。 */
export interface LlmReasoningCapability {
  activation?: LlmReasoningActivationCapability;
  effort?: LlmReasoningEffortCapability;
  budget?: LlmReasoningBudgetCapability;
  defaultSelection?: ReasoningSelection;
  temperaturePolicy: 'allowed' | 'forbidden' | 'forbidden_when_enabled';
  topPPolicy: 'allowed' | 'forbidden' | 'forbidden_when_enabled';
}

/**
 * 由探针实测得出的预设能力档位
 * @description 决定该预设能否被带工具的节点使用。取值必须来自真实探测，不能由配置声明——
 * 「这个中转站支不支持工具往返」只有打过一次才知道。
 */
export type LlmPresetCapability =
  'unverified' | 'unreachable' | 'basic' | 'tools';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** 当前用户消息的一张视觉输入；仅在最终回答节点的内存消息中存在。 */
  image?: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
  /** 仅服务端内部使用；不得进入 REST、SSE、Trace 或客户端状态。 */
  modelContext?: unknown;
}

export interface LlmModelConfig {
  provider: LlmProviderName;
  model: string;
  apiKey?: string;
  baseURL?: string;
  /** 缺省视为 openai_chat_completions，保持既有 ad-hoc 调用路径不变 */
  upstreamFormat?: LlmUpstreamFormat;
}

export interface LlmModelPreset extends LlmModelConfig {
  id: string;
  platform: string;
  enabled?: boolean;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  capability?: LlmPresetCapability;
}

/**
 * 可安全下发前端的模型预设投影
 * @description 与 LlmModelPreset 的关键区别：**没有 apiKey 字段**。密钥只以指纹尾部生成的
 * hint 形式出现。管理端与校验器都只应消费这个类型，避免把带明文 key 的对象递给外部。
 */
export interface LlmModelPresetSummary {
  id: string;
  name: string;
  connectionName: string;
  platform: string;
  model: string;
  provider: LlmProviderName;
  upstreamFormat: LlmUpstreamFormat;
  baseURL?: string;
  enabled: boolean;
  capability: LlmPresetCapability;
  /** 形如 `Key ...a1b2c3`；未配置密钥时为 undefined */
  apiKeyHint?: string;
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  reasoningCapability?: LlmReasoningCapability;
  supportsVision: boolean;
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
  reasoning?: ReasoningSelection;
}

export interface ResolvedLlmModelConfig extends LlmModelConfig {
  id: string;
  platform: string;
  /** 已解析请求上的格式是确定值，不再可缺省 */
  upstreamFormat: LlmUpstreamFormat;
}

export interface ResolvedLlmTextRequest {
  model: ResolvedLlmModelConfig;
  generation: LlmGenerationConfig;
  reasoning?: ReasoningSelection;
}

/** 仅存在于一次模型执行内存中的图片 URL 到 Data URI 替换。 */
export interface LlmVisionRequestTransform {
  sourceUrl: string;
  dataUri: string;
}

export interface LlmStreamOptions {
  abortSignal?: AbortSignal;
}

export interface LlmGenerateOptions {
  abortSignal?: AbortSignal;
}

/** 结构化生成选项 */
export interface LlmStructuredOptions extends LlmGenerateOptions {
  /** 模型选择与生成参数（同 generateChatText 的 request） */
  request?: LlmTextRequest | ResolvedLlmTextRequest;
  /** schema 名称，透传给 provider 的 json_schema.name（便于服务端日志定位） */
  schemaName?: string;
}

export interface LlmTokenUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
}

export interface LlmCacheHitMetrics {
  memorySummaryHit?: boolean;
  providerPromptCacheHit?: boolean;
  contextCacheHit?: boolean;
  cachedInputTokens?: number;
}

export interface LlmRunMetrics {
  tokenUsage?: LlmTokenUsageMetrics;
  cache?: LlmCacheHitMetrics;
  durationMs?: number;
  messageCount?: number;
  summaryMessageCount?: number;
  recentMessageCount?: number;
}

/** 生图请求：模型/尺寸可选，默认取 IMAGE_GEN_* env 配置 */
export interface LlmImageRequest {
  prompt: string;
  /** 形如 1024x1024；不传由模型决定 */
  size?: string;
  /** 覆盖默认生图模型名 */
  model?: string;
  abortSignal?: AbortSignal;
}

/** 生图结果：不同 provider 返回 url 或 base64 二选一 */
export interface LlmImageResult {
  url?: string;
  b64?: string;
  revisedPrompt?: string;
}

/** 参考图生图（edits）请求：参考图以二进制随 multipart 直传 */
export interface LlmImageEditRequest {
  prompt: string;
  /** 参考图（1-N 张；gpt-image 系列支持多参考图高保真输入） */
  images: Array<{ data: Buffer; mimeType?: string }>;
  /** 形如 1024x1024；不传由模型决定 */
  size?: string;
  /** 覆盖默认生图模型名 */
  model?: string;
  abortSignal?: AbortSignal;
}
