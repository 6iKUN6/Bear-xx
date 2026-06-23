import type { ChatCompletionsDto } from "../../api/generated";
import type {
  ChatTaskMeta,
  MessageDonePayload,
  StreamTaskEvent,
} from "./stream-event.types";

export type ChatStreamInput = ChatCompletionsDto;

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
  lastEventId: number;
}

export interface StreamTaskLifecycle {
  onOpen?: () => void;
  onEvent?: (event: StreamTaskEvent) => void;
  onTaskCreated?: (task: ChatTaskMeta, event: StreamTaskEvent) => void;
  onChunk?: (delta: string, event: StreamTaskEvent) => void;
  onToolCall?: (event: StreamTaskEvent) => void;
  onStatus?: (event: StreamTaskEvent) => void;
  onMessageDone?: (
    content: string | undefined,
    event: StreamTaskEvent<MessageDonePayload>,
  ) => void;
  onCompleted?: (event?: StreamTaskEvent) => void;
  onCanceled?: (event?: StreamTaskEvent) => void;
  onError?: (error: Error, event?: StreamTaskEvent) => void;
  onDone?: () => void;
  onLastEventIdChange?: (lastEventId: number) => void;
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
