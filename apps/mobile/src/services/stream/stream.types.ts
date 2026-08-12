import type { ChatCompletionsDto } from "../../api/generated";
import type {
  ChatTaskMeta,
  MessageDonePayload,
  StreamTaskEvent,
} from "./stream-event.types";

export type ChatStreamInput = ChatCompletionsDto & { agentId?: string };

export type StreamTaskStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "retrying"
  | "completed"
  | "error"
  | "canceled";

export interface StreamTaskSnapshot {
  status: StreamTaskStatus;
  task: ChatTaskMeta | null;
  error: Error | null;
  retryCount: number;
  lastEventId: string;
}

export interface StreamTaskLifecycle {
  onOpen?: () => void;
  /**
   * 帧准入判定（去重钩子）：返回 false 则该帧不再派发给任何回调
   * @description 同一个 StreamTask 可能同时存在多条 SSE 连接（典型场景：HITL
   * 审批时首轮流尚未真正关闭、审批流已建立；或恢复探测从 "0" 重放），服务端
   * 按 Redis Stream 向每条连接扇出，同一帧会被投递多次。由调用方
   * （useStreamTask）持有跨连接共享的帧 id 游标做幂等，避免 delta 被重复追加。
   */
  shouldApplyEvent?: (event: StreamTaskEvent) => boolean;
  onEvent?: (event: StreamTaskEvent) => void;
  onTaskCreated?: (task: ChatTaskMeta, event: StreamTaskEvent) => void;
  onChunk?: (delta: string, event: StreamTaskEvent) => void;
  onToolCall?: (event: StreamTaskEvent) => void;
  onStatus?: (event: StreamTaskEvent) => void;
  onConversationTitle?: (
    title: string,
    conversationId: string,
    event: StreamTaskEvent,
  ) => void;
  onApprovalRequired?: (event: StreamTaskEvent) => void;
  onPlanReviewRequired?: (event: StreamTaskEvent) => void;
  onMessageDone?: (
    content: string | undefined,
    event: StreamTaskEvent<MessageDonePayload>,
  ) => void;
  onCompleted?: (event?: StreamTaskEvent) => void;
  onCanceled?: (event?: StreamTaskEvent) => void;
  onError?: (error: Error, event?: StreamTaskEvent) => void;
  onDone?: () => void;
  onLastEventIdChange?: (lastEventId: string) => void;
}

export interface StreamTaskStartOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface StreamTaskHandle {
  abort: () => void;
}

export interface ChatStreamLifecycle extends StreamTaskLifecycle {
  onTools?: (event: StreamTaskEvent) => void;
}
