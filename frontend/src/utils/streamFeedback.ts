import {
  StreamTaskEventType,
  type StreamTaskEvent,
} from "../services/stream/stream-event.types";

const EVENT_LABELS: Record<StreamTaskEventType, string> = {
  [StreamTaskEventType.AgentLoopStart]: "正在分析任务",
  [StreamTaskEventType.StrategySelected]: "已选择执行策略",
  [StreamTaskEventType.SkillSelected]: "已选择能力",
  [StreamTaskEventType.WorkflowStepStart]: "正在执行步骤",
  [StreamTaskEventType.WorkflowStepDone]: "步骤已完成",
  [StreamTaskEventType.ModelCallStart]: "正在请求模型",
  [StreamTaskEventType.ModelCallDone]: "模型响应完成",
  [StreamTaskEventType.ToolCallStart]: "正在调用工具",
  [StreamTaskEventType.ToolCallDelta]: "工具调用中",
  [StreamTaskEventType.ToolCallDone]: "工具调用完成",
  [StreamTaskEventType.ToolCallError]: "工具调用失败",
  [StreamTaskEventType.MessageDelta]: "正在生成回复",
  [StreamTaskEventType.MessageDone]: "回复生成完成",
  [StreamTaskEventType.TaskCreated]: "任务已创建",
  [StreamTaskEventType.TaskStarted]: "任务已开始",
  [StreamTaskEventType.TaskCompleted]: "已完成",
  [StreamTaskEventType.TaskError]: "任务执行失败",
  [StreamTaskEventType.TaskExpired]: "任务已过期",
  [StreamTaskEventType.TaskCanceled]: "任务已取消",
};

const EVENT_TONES: Partial<
  Record<StreamTaskEventType, MessageStreamEventTone>
> = {
  [StreamTaskEventType.WorkflowStepDone]: "success",
  [StreamTaskEventType.ModelCallDone]: "success",
  [StreamTaskEventType.ToolCallDone]: "success",
  [StreamTaskEventType.MessageDone]: "success",
  [StreamTaskEventType.TaskCompleted]: "success",
  [StreamTaskEventType.TaskExpired]: "warning",
  [StreamTaskEventType.TaskCanceled]: "warning",
  [StreamTaskEventType.ToolCallError]: "error",
  [StreamTaskEventType.TaskError]: "error",
};

export function toMessageStreamFeedback(
  event: StreamTaskEvent,
): MessageStreamEventFeedback | null {
  if (event.type === StreamTaskEventType.MessageDelta) {
    return null;
  }

  const type = event.type as StreamTaskEventType;
  const payload = readPayload(event.data.payload);
  const publicStatus = readString(payload.publicStatus);
  const title = publicStatus || EVENT_LABELS[type] || "任务状态更新";
  const detail = event.data.errorMessage || readEventDetail(type, payload);

  return {
    id: `${event.rawId || event.id || Date.now()}-${event.type}`,
    type: event.type,
    title,
    detail,
    tone: EVENT_TONES[type] || "info",
    display: isTerminalTextEvent(type) ? "text" : "panel",
    updatedAt: Date.now(),
  };
}

function isTerminalTextEvent(type: StreamTaskEventType) {
  return (
    type === StreamTaskEventType.TaskCompleted ||
    type === StreamTaskEventType.TaskCanceled ||
    type === StreamTaskEventType.TaskExpired
  );
}

function readPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : {};
}

function readEventDetail(
  type: StreamTaskEventType,
  payload: Record<string, unknown>,
) {
  switch (type) {
    case StreamTaskEventType.StrategySelected:
      return joinParts([
        readString(payload.mode) && `策略 ${readString(payload.mode)}`,
        readString(payload.reason),
      ]);
    case StreamTaskEventType.SkillSelected:
      return joinParts([
        readString(payload.skill) && `能力 ${readString(payload.skill)}`,
        readString(payload.strategy) && `策略 ${readString(payload.strategy)}`,
      ]);
    case StreamTaskEventType.WorkflowStepStart:
    case StreamTaskEventType.WorkflowStepDone:
      return joinParts([
        readString(payload.step) && `步骤 ${readString(payload.step)}`,
        readString(payload.strategy),
      ]);
    case StreamTaskEventType.ModelCallStart:
    case StreamTaskEventType.ModelCallDone:
      return joinParts([
        readString(payload.provider),
        readString(payload.model),
      ]);
    case StreamTaskEventType.ToolCallStart:
    case StreamTaskEventType.ToolCallDelta:
    case StreamTaskEventType.ToolCallDone:
    case StreamTaskEventType.ToolCallError:
      return joinParts([
        readString(payload.name) && `工具 ${readString(payload.name)}`,
        readString(payload.args),
      ]);
    case StreamTaskEventType.TaskCompleted:
      return undefined;
    case StreamTaskEventType.MessageDone:
      return readString(payload.warning) || undefined;
    default:
      return undefined;
  }
}

function joinParts(parts: Array<string | undefined | false>) {
  return parts.filter(Boolean).join(" · ") || undefined;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
