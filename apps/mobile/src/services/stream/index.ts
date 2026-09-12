// 事件信封与分组常量已迁移到 @litter-bear/chat-core（与桌面端共享），
// 这里保留转发以维持 services/stream 的对外面不变。
export {
  StreamTaskEventType,
  TERMINAL_STREAM_TASK_EVENT_TYPES,
  TOOL_STREAM_TASK_EVENT_TYPES,
  STATUS_STREAM_TASK_EVENT_TYPES,
} from "@litter-bear/chat-core";
export type {
  ChatTaskMeta,
  MessageDeltaPayload,
  MessageDonePayload,
  StreamTaskEvent,
  StreamTaskEventEnvelope,
  StreamTaskEventPayload,
} from "@litter-bear/chat-core";
export * from "./stream.types";
export * from "./stream-event.helpers";
export * from "./stream-task.service";
