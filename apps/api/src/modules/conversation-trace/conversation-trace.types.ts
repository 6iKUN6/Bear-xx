import { StreamTaskEventType } from '../stream-task/stream-task-event.types';
import type { StreamTaskPayloadMap } from '@litter-bear/types/protocol';

export {
  ConversationTraceItemStatus,
  ConversationTraceItemType,
} from '@prisma/client';
import type { ConversationTraceItemType as PrismaConversationTraceItemType } from '@prisma/client';

export interface TraceTaskContext {
  userId?: string;
  conversationId: string;
  messageId: string;
  taskId: string;
  runId?: string | null;
}

export interface TraceItemBaseInput extends TraceTaskContext {
  parentId?: string | null;
  traceKey?: string | null;
  type: PrismaConversationTraceItemType;
  title: string;
  summary?: string | null;
  detail?: string | null;
  strategy?: string | null;
  skill?: string | null;
  graph?: string | null;
  nodeKey?: string | null;
  toolName?: string | null;
  mcpServer?: string | null;
  mcpTool?: string | null;
  inputSummary?: unknown;
  outputSummary?: unknown;
  error?: unknown;
  metrics?: unknown;
  metadata?: unknown;
  startedAt?: Date;
  endedAt?: Date;
}

export type StartTraceItemInput = TraceItemBaseInput;

export interface CompleteTraceItemInput {
  taskId: string;
  traceKey?: string | null;
  nodeKey?: string | null;
  title?: string;
  summary?: string | null;
  detail?: string | null;
  mcpServer?: string | null;
  mcpTool?: string | null;
  outputSummary?: unknown;
  metrics?: unknown;
  metadata?: unknown;
  endedAt?: Date;
}

export interface FailTraceItemInput extends TraceItemBaseInput {
  error: unknown;
}

export type TraceCommand =
  | {
      action: 'start';
      input: StartTraceItemInput;
    }
  | {
      action: 'complete';
      input: CompleteTraceItemInput;
    }
  | {
      action: 'fail';
      input: FailTraceItemInput;
    }
  | {
      action: 'create-success';
      input: StartTraceItemInput;
    };

/**
 * 流式事件 → trace 的输入
 * @description 按事件类型展开成判别联合，`switch (input.eventName)` 即可把
 * `input.payload` 收窄到对应契约。此前是 `Record<string, unknown>` + 按 key
 * 动态读取，读到契约上根本不存在的字段也不会报错——映射里因此积了不少永远
 * 取不到值的兜底分支。
 */
export type RecordStreamEventInputOf<K extends StreamTaskEventType> =
  TraceTaskContext & {
    eventName: K;
    payload?: StreamTaskPayloadMap[K];
    errorMessage?: string;
  };

export type RecordStreamEventInput = {
  [K in StreamTaskEventType]: RecordStreamEventInputOf<K>;
}[StreamTaskEventType];
