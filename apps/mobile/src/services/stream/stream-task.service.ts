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

/** GET /stream-tasks/:id 的恢复判定字段（只取续接需要的子集） */
export interface StreamTaskStatusSnapshot {
  taskId: string;
  status: string;
  conversationId: string;
  messageId: string;
  lastEventId: number;
  fullContent: string;
  errorMessage: string | null;
  canResume: boolean;
}

export class StreamTaskService {
  /** 查询任务状态：跨页面回到会话时判断「续接还是取终稿」 */
  async getTaskStatus(taskId: string): Promise<StreamTaskStatusSnapshot> {
    return apiClient.request<StreamTaskStatusSnapshot>({
      url: `/api/stream-tasks/${taskId}`,
      method: "GET",
    });
  }

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
