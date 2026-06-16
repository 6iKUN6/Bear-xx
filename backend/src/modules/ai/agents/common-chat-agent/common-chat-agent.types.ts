import type { LlmMessage } from '../../../llm/llm.types';
import { StreamTaskEventType } from '../../../stream-task/stream-task-event.types';

export interface CommonChatAgentLoopRequest {
  messages: LlmMessage[];
  systemPrompt?: string;
  tools?: unknown[];
  abortSignal?: AbortSignal;
}

export type CommonChatAgentStreamEvent =
  | {
      type: StreamTaskEventType.MessageDelta;
      delta: string;
    }
  | {
      type: StreamTaskEventType.ToolCallDelta;
      toolCallId?: string;
      name?: string;
      args?: string;
      index?: number;
    };
