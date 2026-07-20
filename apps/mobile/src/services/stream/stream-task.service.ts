import type { ApprovalDecision } from "@litter-bear/types/protocol";
import { apiClient, type StreamEvent } from "../../api/request";
import {
  dispatchStreamTaskEvent,
  isTerminalStreamTaskEvent,
  normalizeStreamTaskEvent,
} from "./stream-event.helpers";
import type {
  ChatStreamInput,
  StreamTaskHandle,
  StreamTaskLifecycle,
} from "./stream.types";

export class StreamTaskService {
  startChatMessage(
    input: ChatStreamInput,
    lifecycle: StreamTaskLifecycle = {},
  ): StreamTaskHandle {
    return this.openStream(
      {
        url: "/api/chat/message",
        method: "POST",
        data: input,
      },
      lifecycle,
    );
  }

  resumeTask(
    taskId: string,
    lastEventId?: string,
    lifecycle: StreamTaskLifecycle = {},
  ): StreamTaskHandle {
    const body: { lastEventId?: string } = {};
    if (lastEventId) {
      body.lastEventId = lastEventId;
    }

    return this.openStream(
      {
        url: `/api/stream-tasks/${taskId}/resume`,
        method: "POST",
        data: body,
      },
      lifecycle,
    );
  }

  submitApproval(
    taskId: string,
    decision: ApprovalDecision,
    lastEventId?: string,
    lifecycle: StreamTaskLifecycle = {},
  ): StreamTaskHandle {
    const body: ApprovalDecision & { lastEventId?: string } = { ...decision };
    if (lastEventId) {
      body.lastEventId = lastEventId;
    }

    return this.openStream(
      {
        url: `/api/stream-tasks/${taskId}/approval`,
        method: "POST",
        data: body,
      },
      lifecycle,
    );
  }

  async cancelTask(taskId: string): Promise<void> {
    await apiClient.request<unknown>({
      url: `/api/stream-tasks/${taskId}/cancel`,
      method: "POST",
    });
  }

  private openStream<TBody>(
    options: {
      url: string;
      method: "POST";
      data: TBody;
    },
    lifecycle: StreamTaskLifecycle,
  ): StreamTaskHandle {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      lifecycle.onDone?.();
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      lifecycle.onError?.(error);
      lifecycle.onDone?.();
    };

    const handle = apiClient.stream<unknown, TBody>(options, {
      onOpen: lifecycle.onOpen,
      onMessage: (rawEvent: StreamEvent<unknown>) => {
        if (settled) {
          return;
        }

        const event = normalizeStreamTaskEvent(rawEvent);
        dispatchStreamTaskEvent(event, lifecycle);

        if (isTerminalStreamTaskEvent(event)) {
          finish();
        }
      },
      onDone: finish,
      onError: fail,
    });

    return handle;
  }
}

export const streamTaskService = new StreamTaskService();
