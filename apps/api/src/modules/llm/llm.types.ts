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
