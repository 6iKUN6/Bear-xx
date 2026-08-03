import type { StreamEvent } from "../../api/request";
import {
  STATUS_STREAM_TASK_EVENT_TYPES,
  StreamTaskEventType,
  TERMINAL_STREAM_TASK_EVENT_TYPES,
  TOOL_STREAM_TASK_EVENT_TYPES,
  type ChatTaskMeta,
  type MessageDeltaPayload,
  type MessageDonePayload,
  type StreamTaskEvent,
  type StreamTaskEventPayload,
} from "./stream-event.types";
import type { StreamTaskLifecycle } from "./stream.types";

export function normalizeStreamTaskEvent(
  rawEvent: StreamEvent<unknown>,
): StreamTaskEvent {
  const data = normalizeStreamTaskEventPayload(rawEvent.data);
  const type = rawEvent.event || data.type || "";

  return {
    id: normalizeEventId(rawEvent.id),
    rawId: rawEvent.id,
    type,
    data: {
      ...data,
      type,
    },
    rawData: rawEvent.rawData,
  };
}

export function dispatchStreamTaskEvent(
  event: StreamTaskEvent,
  lifecycle: StreamTaskLifecycle,
) {
  lifecycle.onEvent?.(event);

  if (event.rawId) {
    lifecycle.onLastEventIdChange?.(event.rawId);
  }

  if (event.type === StreamTaskEventType.TaskCreated) {
    const task = getChatTaskMeta(event);
    if (task) {
      lifecycle.onTaskCreated?.(task, event);
    }
    return;
  }

  if (event.type === StreamTaskEventType.MessageDelta) {
    const payload = event.data.payload as MessageDeltaPayload | undefined;
    if (payload?.delta) {
      lifecycle.onChunk?.(payload.delta, event);
    }
    return;
  }

  if (event.type === StreamTaskEventType.MessageDone) {
    const payload = event.data.payload as MessageDonePayload | undefined;
    lifecycle.onMessageDone?.(
      payload?.content,
      event as StreamTaskEvent<MessageDonePayload>,
    );
    return;
  }

  if (event.type === StreamTaskEventType.ApprovalRequired) {
    lifecycle.onApprovalRequired?.(event);
    return;
  }

  if (event.type === StreamTaskEventType.ConversationTitleUpdated) {
    const payload = event.data.payload as
      | { conversationId?: string; title?: string }
      | undefined;
    const conversationId = payload?.conversationId || event.data.conversationId;
    if (payload?.title && conversationId) {
      lifecycle.onConversationTitle?.(payload.title, conversationId, event);
    }
    return;
  }

  if (TOOL_STREAM_TASK_EVENT_TYPES.has(event.type as StreamTaskEventType)) {
    lifecycle.onToolCall?.(event);
  }

  if (STATUS_STREAM_TASK_EVENT_TYPES.has(event.type as StreamTaskEventType)) {
    lifecycle.onStatus?.(event);
  }

  if (event.type === StreamTaskEventType.TaskCompleted) {
    lifecycle.onCompleted?.(event);
    return;
  }

  if (event.type === StreamTaskEventType.TaskCanceled) {
    lifecycle.onCanceled?.(event);
    return;
  }

  if (
    event.type === StreamTaskEventType.TaskError ||
    event.type === StreamTaskEventType.TaskExpired
  ) {
    lifecycle.onError?.(createStreamTaskError(event), event);
  }
}

export function isTerminalStreamTaskEvent(event: StreamTaskEvent) {
  return TERMINAL_STREAM_TASK_EVENT_TYPES.has(
    event.type as StreamTaskEventType,
  );
}

export function getChatTaskMeta(event: StreamTaskEvent): ChatTaskMeta | null {
  const { taskId, conversationId, messageId, streamId, status } = event.data;

  if (!taskId || !conversationId) {
    return null;
  }

  return {
    taskId,
    conversationId,
    messageId,
    streamId,
    status,
  };
}

export function createStreamTaskError(event: StreamTaskEvent) {
  if (event.type === StreamTaskEventType.TaskExpired) {
    return new Error(event.data.errorMessage || "聊天任务已过期");
  }

  if (event.type === StreamTaskEventType.TaskCanceled) {
    return new Error(event.data.errorMessage || "聊天任务已取消");
  }

  return new Error(event.data.errorMessage || "聊天任务执行失败");
}

function normalizeStreamTaskEventPayload(
  data: unknown,
): StreamTaskEventPayload {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as StreamTaskEventPayload;
    } catch {
      return {};
    }
  }

  if (data && typeof data === "object") {
    return data as StreamTaskEventPayload;
  }

  return {};
}

function normalizeEventId(id?: string) {
  if (!id) {
    return undefined;
  }

  const parsedId = Number(id);
  return Number.isFinite(parsedId) ? parsedId : undefined;
}
