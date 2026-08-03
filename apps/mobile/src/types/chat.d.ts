type MessageRole = "user" | "assistant";
type MessageStatus = "sending" | "streaming" | "done" | "error";
type MessageStreamEventTone = "info" | "success" | "warning" | "error";
type MessageStreamEventDisplay = "panel" | "text";

interface MessageStreamEventFeedback {
  id: string;
  type: string;
  title: string;
  detail?: string;
  tone: MessageStreamEventTone;
  display: MessageStreamEventDisplay;
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
}

interface Message {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  createdAt: number;
  /** 发言智能体 id；null/缺省 = 用户消息或默认助手 */
  agentId?: string | null;
  /** 发言智能体名称（群聊气泡展示用） */
  agentName?: string | null;
  metrics?: MessageRunMetrics | null;
  trace?: MessageTraceItem[];
  streamFeedback?: MessageStreamFeedbackState;
  currentStreamEvent?: MessageStreamEventFeedback;
  /** HITL：待人工审批的工具调用（approval.required 载荷）；处理后清空 */
  pendingApproval?: import("@litter-bear/types/protocol").ApprovalRequiredPayload;
}

interface Conversation {
  id: string;
  title: string;
  /** 群成员：会话中出现过的智能体 id 列表；空/缺省 = 单助手会话 */
  agentIds?: string[];
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}
