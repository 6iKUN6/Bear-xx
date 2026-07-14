import {
  StreamTaskEventType,
  type StreamTaskEvent,
} from "../services/stream/stream-event.types";
// 中文文案来自前后端共享包（唯一事实源）
import { STREAM_TASK_EVENT_LABELS as EVENT_LABELS } from "@litter-bear/types/protocol";

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

export function buildStreamFeedbackFromTrace(
  trace?: MessageTraceItem[],
): MessageStreamFeedbackState | undefined {
  const events = trace
    ?.slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map(toMessageStreamFeedbackFromTrace)
    .filter((event): event is MessageStreamEventFeedback => Boolean(event));

  if (!events?.length) {
    return undefined;
  }

  const current = findLastInfoEvent(events) || events[events.length - 1];

  return {
    current,
    events,
    expanded: false,
  };
}

export function toMessageStreamFeedbackFromTrace(
  traceItem: MessageTraceItem,
): MessageStreamEventFeedback | null {
  if (!traceItem.title?.trim()) {
    return null;
  }

  return {
    id: traceItem.id,
    type: traceItem.type,
    title: traceItem.title,
    detail: joinParts([
      traceItem.summary || undefined,
      formatTraceDuration(traceItem.durationMs),
    ]),
    tone: traceStatusTone(traceItem.status),
    display: traceItem.type === "MESSAGE_FINALIZE" ? "text" : "panel",
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

function findLastInfoEvent(events: MessageStreamEventFeedback[]) {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.tone === "info") {
      return event;
    }
  }

  return undefined;
}

function traceStatusTone(status: string): MessageStreamEventTone {
  const normalizedStatus = status.toUpperCase();
  if (normalizedStatus === "SUCCESS") {
    return "success";
  }

  if (normalizedStatus === "ERROR") {
    return "error";
  }

  if (normalizedStatus === "SKIPPED" || normalizedStatus === "CANCELED") {
    return "warning";
  }

  return "info";
}

function formatTraceDuration(durationMs?: number | null) {
  if (!durationMs || durationMs <= 0) {
    return undefined;
  }

  if (durationMs >= 1000) {
    return `耗时 ${(durationMs / 1000).toFixed(1)}s`;
  }

  return `耗时 ${durationMs}ms`;
}
