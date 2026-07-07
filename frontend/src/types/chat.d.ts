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
  metrics?: MessageRunMetrics | null;
  trace?: MessageTraceItem[];
  streamFeedback?: MessageStreamFeedbackState;
  currentStreamEvent?: MessageStreamEventFeedback;
}

interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
}
