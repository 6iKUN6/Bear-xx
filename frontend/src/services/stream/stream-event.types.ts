export enum StreamTaskEventType {
  AgentLoopStart = "agent.loop.start",
  StrategySelected = "strategy.selected",
  SkillSelected = "skill.selected",
  WorkflowStepStart = "workflow.step.start",
  WorkflowStepDone = "workflow.step.done",
  ModelCallStart = "model.call.start",
  ModelCallDone = "model.call.done",
  ToolCallStart = "tool.call.start",
  ToolCallDelta = "tool.call.delta",
  ToolCallDone = "tool.call.done",
  ToolCallError = "tool.call.error",
  MessageDelta = "message.delta",
  MessageDone = "message.done",
  TaskCreated = "task.created",
  TaskStarted = "task.started",
  TaskCompleted = "task.completed",
  TaskError = "task.error",
  TaskExpired = "task.expired",
  TaskCanceled = "task.canceled",
}

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
