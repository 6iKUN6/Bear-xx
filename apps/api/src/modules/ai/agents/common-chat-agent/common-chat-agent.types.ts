import type { LlmMessage } from '../../../llm/llm.types';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

export interface CommonChatAgentLoopRequest {
  messages: LlmMessage[];
  systemPrompt?: string;
  tools?: unknown[];
  /** HITL 会话标识（checkpointer thread_id）；= taskId */
  threadId?: string;
  /** 需要人工审批的工具名，驱动 HITL 中间件 interruptOn */
  approvalToolNames?: string[];
  abortSignal?: AbortSignal;
}

export type CommonChatAgentStreamEvent =
  | {
      type: StreamTaskEventType.MessageDelta;
      delta: string;
    }
  | {
      type: StreamTaskEventType.ToolCallStart;
      payload: Record<string, unknown>;
    }
  | {
      type: StreamTaskEventType.ToolCallDelta;
      toolCallId?: string;
      name?: string;
      args?: string;
      index?: number;
    }
  | {
      type: StreamTaskEventType.ToolCallDone;
      payload: Record<string, unknown>;
    }
  | {
      type: StreamTaskEventType.ToolCallError;
      payload: Record<string, unknown>;
    }
  | {
      type: StreamTaskEventType.ApprovalRequired;
      payload: Record<string, unknown>;
    };
