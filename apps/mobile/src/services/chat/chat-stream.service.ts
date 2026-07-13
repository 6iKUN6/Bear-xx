import { streamTaskService } from "../stream/stream-task.service";
import type {
  ChatStreamInput,
  ChatStreamLifecycle,
  StreamTaskHandle,
  StreamTaskLifecycle,
} from "../stream/stream.types";

export class ChatStreamService {
  sendMessage(
    input: ChatStreamInput,
    lifecycle: ChatStreamLifecycle = {},
  ): StreamTaskHandle {
    return streamTaskService.startChatMessage(
      input,
      this.normalizeLifecycle(lifecycle),
    );
  }

  resumeMessage(
    taskId: string,
    lastEventId?: string,
    lifecycle: ChatStreamLifecycle = {},
  ): StreamTaskHandle {
    return streamTaskService.resumeTask(
      taskId,
      lastEventId,
      this.normalizeLifecycle(lifecycle),
    );
  }

  cancelMessage(taskId: string): Promise<void> {
    return streamTaskService.cancelTask(taskId);
  }

  private normalizeLifecycle(
    lifecycle: ChatStreamLifecycle,
  ): StreamTaskLifecycle {
    return {
      ...lifecycle,
      onToolCall: (event) => {
        lifecycle.onToolCall?.(event);
        lifecycle.onTools?.(event);
      },
    };
  }
}

export const chatStreamService = new ChatStreamService();
