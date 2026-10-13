import type { ModelInvocationUsage } from "@litter-bear/types/protocol";
import type { ReasoningSelection } from "@litter-bear/types";
import type { ModelContextSources } from "@litter-bear/types/protocol";
/**
 * 聊天展示层的跨端共享类型
 * @description 这些是前端展示状态（非线上传输契约——契约在 @litter-bear/types/protocol），
 * 由移动端的 chat.d.ts 环境声明迁移而来，供小程序与桌面端共用。
 */

export type MessageRole = "user" | "assistant";
export type MessageStatus = "sending" | "streaming" | "done" | "error";
export type MessageStreamEventTone = "info" | "success" | "warning" | "error";
export type MessageStreamEventDisplay = "panel" | "text";
export type MessageTraceStage =
  "context" | "model" | "tool" | "approval" | "output" | "error" | "workflow";

export interface MessageStreamEventFeedback {
  invocations?: ModelInvocationUsage[];
  id: string;
  type: string;
  title: string;
  detail?: string;
  tone: MessageStreamEventTone;
  display: MessageStreamEventDisplay;
  stage?: MessageTraceStage;
  toolName?: string;
  /** 工具完成后由服务端提供的安全摘要，不包含工具入参。 */
  toolSummary?: string;
  /** 该步耗时（毫秒）；flow 节点完成 / 历史 trace 时下发 */
  durationMs?: number | null;
  inputSummary?: Record<string, unknown> | null;
  outputSummary?: Record<string, unknown> | null;
  /** 模型节点的运行信息（模型调用事件专用）。 */
  model?: string;
  provider?: string;
  modelPresetId?: string;
  contextSources?: ModelContextSources;
  inputTokenLimit?: number;
  peakInputTokens?: number;
  contextUsageEstimated?: boolean;
  contextWindowTokens?: number;
  estimatedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  contextUsagePercent?: number;
  estimated?: boolean;
  /** 只标记思考配置，不承载供应商私有思维链。 */
  reasoningEnabled?: boolean;
  reasoningEffort?: string;
  reasoningBudgetTokens?: number | "auto";
  updatedAt: number;
}

export interface MessageStreamFeedbackState {
  current?: MessageStreamEventFeedback;
  events: MessageStreamEventFeedback[];
  expanded: boolean;
}

export interface MessageTokenUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
}

export interface MessageCacheHitMetrics {
  memorySummaryHit?: boolean;
  providerPromptCacheHit?: boolean;
  contextCacheHit?: boolean;
  cachedInputTokens?: number;
}

export interface MessageRunMetrics {
  invocations?: ModelInvocationUsage[];
  model?: string;
  provider?: string;
  modelPresetId?: string;
  contextSources?: ModelContextSources;
  inputTokenLimit?: number;
  peakInputTokens?: number;
  contextUsageEstimated?: boolean;
  contextWindowTokens?: number;
  estimatedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  contextUsagePercent?: number;
  estimated?: boolean;
  reasoning?: ReasoningSelection;
  tokenUsage?: MessageTokenUsageMetrics;
  cache?: MessageCacheHitMetrics;
  durationMs?: number;
  messageCount?: number;
  summaryMessageCount?: number;
  recentMessageCount?: number;
  contentLength?: number;
}

export interface MessageTraceItem {
  id: string;
  type: string;
  status: string;
  title: string;
  summary?: string | null;
  durationMs?: number | null;
  depth: number;
  sequence: number;
  metrics?: MessageRunMetrics | null;
  toolName?: string | null;
  parentId?: string | null;
  inputSummary?: Record<string, unknown> | null;
  outputSummary?: Record<string, unknown> | null;
}
