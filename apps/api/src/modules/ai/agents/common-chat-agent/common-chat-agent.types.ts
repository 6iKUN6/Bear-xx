import type {
  ApprovalRequiredPayload,
  ToolCallDeltaPayload,
  ToolCallDonePayload,
  ToolCallErrorPayload,
  ToolCallStartPayload,
} from '@litter-bear/types/protocol';
import type { BaseMessage } from '@langchain/core/messages';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

export interface CommonChatAgentLoopRequest {
  messages: BaseMessage[];
  systemPrompt?: string;
  tools?: unknown[];
  /** HITL 会话标识（checkpointer thread_id）；= taskId */
  threadId?: string;
  /** 需要人工审批的工具名，驱动 HITL 中间件 interruptOn */
  approvalToolNames?: string[];
  abortSignal?: AbortSignal;
  /**
   * 底层模型每被真实调用一次回调一次
   * @description 供 AgentFlow 的 maxModelCalls 预算护栏精确计数。做成回调而非新增流事件
   * 变体：CommonChatAgentStreamEvent 会被旧链路的 graph 原样 `yield` 转发进 SSE，新增变体
   * 会直接漏给前端。不传时行为完全不变。
   */
  onModelTurn?: () => void;
  /** Agent 正常完成后交付本轮新增的原始 AI/tool 消息；等待审批时不触发。 */
  onCompletedMessages?: (messages: BaseMessage[]) => void | Promise<void>;
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
