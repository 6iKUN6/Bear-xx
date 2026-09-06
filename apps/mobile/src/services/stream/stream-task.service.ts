import type {
  ApprovalDecision,
  PlanReviewDecision,
} from "@litter-bear/types/protocol";
import { apiClient, type StreamEvent } from "../../api/request";
import {
  dispatchStreamTaskEvent,
  isTerminalStreamTaskEvent,
  normalizeStreamTaskEvent,
} from "./stream-event.helpers";
import type {
  ChatTaskResultDto,
  ReasoningSelectionDto,
} from "../../api/generated/models";
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

export interface VoiceTaskInput {
  filePath: string;
  conversationId?: string;
  agentId?: string;
  selectedModelPresetId?: string;
  reasoning?: ReasoningSelectionDto;
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

  /**
   * 上传语音并创建聊天任务
   * @param input 音频临时路径以及本轮 Agent、模型和思考选择
   * @returns 返回已创建任务的稳定标识
   * @description reasoning 按 multipart 契约序列化成 JSON 字符串；任务创建后由调用方
   * 使用同一个 taskId 接入现有 resume SSE 链路，避免为语音复制一套流协议。
   */
  async createVoiceTask(input: VoiceTaskInput): Promise<ChatTaskResultDto> {
    const formData: Record<string, string> = {};
    if (input.conversationId) formData.conversationId = input.conversationId;
    if (input.agentId) formData.agentId = input.agentId;
    if (input.selectedModelPresetId) {
      formData.selectedModelPresetId = input.selectedModelPresetId;
    }
    if (input.reasoning) {
      formData.reasoning = JSON.stringify(input.reasoning);
    }

    return apiClient.upload<ChatTaskResultDto, Record<string, string>>({
      url: "/api/chat/voice-messages",
      method: "POST",
      filePath: input.filePath,
      name: "audio",
      formData,
    });
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

  submitPlanReview(
    taskId: string,
    decision: PlanReviewDecision,
    lastEventId?: string,
    lifecycle: StreamTaskLifecycle = {},
  ): StreamTaskHandle {
    const body: PlanReviewDecision & { lastEventId?: string } = { ...decision };
    if (lastEventId) {
      body.lastEventId = lastEventId;
    }

    return this.openStream(
      {
        url: `/api/stream-tasks/${taskId}/plan-review`,
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

    return {
      abort: () => {
        // 置 settled 让 onMessage 的闸门立即生效：abort 后仍可能有已到达
        // 但未派发的帧，它们不应再进入 lifecycle（该 lifecycle 可能已被新连接共用）。
        settled = true;
        handle.abort();
      },
    };
  }
}

export const streamTaskService = new StreamTaskService();
