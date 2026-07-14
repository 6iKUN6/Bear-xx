// 事件类型来自前后端共享包（唯一事实源）；本文件仅保留前端消费侧的分组与结构。
import { StreamTaskEventType } from "@litter-bear/types/protocol";

export { StreamTaskEventType };
export type { StreamTaskEventEnvelope } from "@litter-bear/types/protocol";

export const TERMINAL_STREAM_TASK_EVENT_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.TaskCompleted,
  StreamTaskEventType.TaskError,
  StreamTaskEventType.TaskExpired,
  StreamTaskEventType.TaskCanceled,
]);

export const TOOL_STREAM_TASK_EVENT_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.ToolCallStart,
  StreamTaskEventType.ToolCallDelta,
  StreamTaskEventType.ToolCallDone,
  StreamTaskEventType.ToolCallError,
]);

export const STATUS_STREAM_TASK_EVENT_TYPES = new Set<StreamTaskEventType>([
  StreamTaskEventType.AgentLoopStart,
  StreamTaskEventType.StrategySelected,
  StreamTaskEventType.SkillSelected,
  StreamTaskEventType.WorkflowStepStart,
  StreamTaskEventType.WorkflowStepDone,
  StreamTaskEventType.ModelCallStart,
  StreamTaskEventType.ModelCallDone,
  StreamTaskEventType.TaskStarted,
]);

export interface StreamTaskEventPayload<TPayload = unknown> {
  type?: StreamTaskEventType | string;
  taskId?: string;
  streamId?: string;
  conversationId?: string;
  messageId?: string;
  status?: string;
  payload?: TPayload;
  errorMessage?: string;
}

export interface MessageDeltaPayload {
  delta?: string;
}

export interface MessageDonePayload {
  content?: string;
  warning?: string;
  metrics?: MessageRunMetrics;
}

export interface ChatTaskMeta {
  taskId: string;
  conversationId: string;
  messageId?: string;
  streamId?: string;
  status?: string;
}

export interface StreamTaskEvent<TPayload = unknown> {
  id?: number;
  rawId?: string;
  type: StreamTaskEventType | string;
  data: StreamTaskEventPayload<TPayload>;
  rawData: string;
}
