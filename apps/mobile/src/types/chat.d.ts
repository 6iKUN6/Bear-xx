type MessageRole = "user" | "assistant";
type MessageStatus = "sending" | "streaming" | "done" | "error";
type MessageStreamEventTone = "info" | "success" | "warning" | "error";
type MessageStreamEventDisplay = "panel" | "text";
type MessageTraceStage =
  "context" | "model" | "tool" | "approval" | "output" | "error" | "workflow";

interface MessageStreamEventFeedback {
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
  updatedAt: number;
}

interface MessageStreamFeedbackState {
  current?: MessageStreamEventFeedback;
  events: MessageStreamEventFeedback[];
  expanded: boolean;
}

interface MessageTokenUsageMetrics {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  estimated?: boolean;
}

interface MessageCacheHitMetrics {
  memorySummaryHit?: boolean;
  providerPromptCacheHit?: boolean;
  contextCacheHit?: boolean;
  cachedInputTokens?: number;
}

interface MessageRunMetrics {
  tokenUsage?: MessageTokenUsageMetrics;
  cache?: MessageCacheHitMetrics;
  durationMs?: number;
  messageCount?: number;
  summaryMessageCount?: number;
  recentMessageCount?: number;
  contentLength?: number;
}

interface MessageTraceItem {
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

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  /** 用户上传图片或 AI 生图的动态访问 URL。 */
  imageUrl?: string | null;
  status: MessageStatus;
  createdAt: number;
  /** 发言智能体 id；null/缺省 = 用户消息或默认助手 */
  agentId?: string | null;
  /** 发言智能体名称（群聊气泡展示用） */
  agentName?: string | null;
  /**
   * 等待后端指派回答者
   * @description 群聊未 @ 时回答者由后端自动路由决定，发送时前端并不知道是谁。
   * 此标记期间气泡不显示任何具体身份（避免误显示成默认助手），
   * 待 task.created 带回真实回答者后清除。
   */
  routing?: boolean;
  metrics?: MessageRunMetrics | null;
  trace?: MessageTraceItem[];
  streamFeedback?: MessageStreamFeedbackState;
  currentStreamEvent?: MessageStreamEventFeedback;
  /** HITL：待人工审批的工具调用（approval.required 载荷）；处理后清空 */
  pendingApproval?: import("@litter-bear/types/protocol").ApprovalRequiredPayload;
  /** HITL：已处理的工具审批结论（决定 + 原载荷）；用于收敛为一行展示 */
  resolvedApproval?: {
    decision: import("@litter-bear/types/protocol").ApprovalDecisionType;
    payload: import("@litter-bear/types/protocol").ApprovalRequiredPayload;
  };
  /** HITL：待人工确认的执行计划（plan.review.required 载荷）；处理后清空 */
  pendingPlanReview?: import("@litter-bear/types/protocol").PlanReviewRequiredPayload;
  /** 由 order.created 实时下发或会话历史回填的安全订单卡片。 */
  orders?: import("../api/mcdonaldsOrder").McDonaldsOrder[];
}

type ConversationType = "SINGLE" | "GROUP";

interface Conversation {
  id: string;
  title: string;
  /** 会话形态；缺省 = 本地草稿/旧数据（按未定型处理） */
  type?: ConversationType;
  /** GROUP=可 @ 的成员列表；SINGLE=绑定的智能体 */
  agentIds?: string[];
  /** 默认回答者；GROUP 下 null = 自动路由 */
  defaultAgentId?: string | null;
  /** 本地记录上一轮已提交的模型选择，只用于给出上下文切换建议 */
  lastModelSelectionFingerprint?: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}
