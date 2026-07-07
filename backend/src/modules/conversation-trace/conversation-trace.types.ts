import { StreamTaskEventType } from '../stream-task/stream-task-event.types';

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

export interface RecordStreamEventInput extends TraceTaskContext {
  eventName: StreamTaskEventType;
  payload?: Record<string, unknown>;
  errorMessage?: string;
}
