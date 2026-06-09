import type { LlmMessage } from '../../../llm/llm.types';

export interface CommonChatAgentLoopRequest {
  messages: LlmMessage[];
  systemPrompt?: string;
  tools?: unknown[];
  abortSignal?: AbortSignal;
}

export type CommonChatAgentStreamEvent =
  | {
      type: 'message.delta';
      delta: string;
    }
  | {
      type: 'tool.call.delta';
      toolCallId?: string;
      name?: string;
      args?: string;
      index?: number;
    };
