import { useCallback } from "react";
import { useStreamTask } from "./useStreamTask";
import type {
  ChatStreamInput,
  ChatStreamLifecycle,
  StreamTaskStartOptions,
} from "../services/stream";

export function useChatStream(options: StreamTaskStartOptions = {}) {
  const { startChatMessage, ...streamTask } = useStreamTask(options);

  const sendMessage = useCallback(
    (input: ChatStreamInput, lifecycle: ChatStreamLifecycle = {}) => {
      return startChatMessage(input, {
        ...lifecycle,
        onToolCall: (event) => {
          lifecycle.onToolCall?.(event);
          lifecycle.onTools?.(event);
        },
      });
    },
    [startChatMessage],
  );

  return {
    ...streamTask,
    startChatMessage,
    sendMessage,
  };
}
