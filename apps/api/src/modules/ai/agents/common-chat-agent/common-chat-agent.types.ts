import type {
  ApprovalRequiredPayload,
  ToolCallDeltaPayload,
  ToolCallDonePayload,
  ToolCallErrorPayload,
  ToolCallStartPayload,
} from '@litter-bear/types/protocol';
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

/**
 * agent 层事件流
 * @description 载荷契约复用共享包，但**两个 delta 事件在本层是顶层字段**
 * （`event.delta` / `event.args`），到 stream-task 层才被重新包进 payload；
 * 其余事件的 payload 与线上形状一致。此前这些 payload 是
 * `Record<string, unknown>`——字段名写错不报错，前端只能猜。
 */
export type CommonChatAgentStreamEvent =
  | {
      type: StreamTaskEventType.MessageDelta;
      delta: string;
    }
  | {
      type: StreamTaskEventType.ToolCallStart;
      payload: ToolCallStartPayload;
    }
  | ({
      type: StreamTaskEventType.ToolCallDelta;
    } & ToolCallDeltaPayload)
  | {
      type: StreamTaskEventType.ToolCallDone;
      payload: ToolCallDonePayload;
    }
  | {
      type: StreamTaskEventType.ToolCallError;
      payload: ToolCallErrorPayload;
    }
  | {
      type: StreamTaskEventType.ApprovalRequired;
      payload: ApprovalRequiredPayload;
    };
