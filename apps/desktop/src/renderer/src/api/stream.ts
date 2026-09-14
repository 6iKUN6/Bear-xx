import type {
  ApprovalDecision,
  StreamTaskEventEnvelope,
} from "@litter-bear/types/protocol";
import { authStorage } from "./auth-storage";
import { API_BASE_URL } from "./client";
import type { ChatMessageInput } from "./types";

export interface ChatStreamHandlers {
  /** 每收到一帧业务事件回调；frameId 为 SSE `id:` 行（Redis Stream 游标），用于续跑去重 */
  onEvent: (event: StreamTaskEventEnvelope, frameId?: string) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

export interface StreamHandle {
  abort: () => void;
}

/**
 * 发送消息并消费 SSE 流（POST /chat/message）
 * @description 用 fetch + ReadableStream 带 Bearer 消费 SSE（EventSource 无法带
 * Authorization）。逐帧解析 `id:`/`event:`/`data:`，回调 onEvent。返回可 abort 的句柄。
 * 401 不走自动刷新：流中断比重新发起更坏，直接报错让上层提示重新登录。
 */
export function streamChatMessage(
  body: ChatMessageInput,
  handlers: ChatStreamHandlers,
): StreamHandle {
  return openSseStream("/api/chat/message", body, handlers, "发送失败");
}

/**
 * 提交人工审批决定并续跑（POST /stream-tasks/:taskId/approval，HITL）
 * @description 审批端点同样是 SSE：提交 decide 后任务从中断处继续推流，
 * 复用同一套帧解析与事件回调。lastEventId 传断点游标，服务端只补新帧。
 */
export function streamApproval(
  taskId: string,
  decision: ApprovalDecision,
  lastEventId: string | undefined,
  handlers: ChatStreamHandlers,
): StreamHandle {
  return openSseStream(
    `/api/stream-tasks/${taskId}/approval`,
    { ...decision, lastEventId },
    handlers,
    "提交审批失败",
  );
}

/** 打开一条 POST SSE 流并逐帧回调；返回可 abort 句柄 */
function openSseStream(
  path: string,
  body: unknown,
  handlers: ChatStreamHandlers,
  failureLabel: string,
): StreamHandle {
  const controller = new AbortController();
  const token = authStorage.getToken();

  void (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 401) {
        authStorage.clear();
        window.dispatchEvent(new CustomEvent("sola:unauthorized"));
        throw new Error("登录已过期，请重新登录");
      }
      if (!response.ok || !response.body) {
        throw new Error(`${failureLabel}（${response.status}）`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        buffer = consumeFrames(buffer, handlers);
      }
      handlers.onDone();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      handlers.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  })();

  return { abort: () => controller.abort() };
}

/** 按空行分割 SSE 帧，解析 id:/data:，返回剩余未完整的 buffer */
function consumeFrames(buffer: string, handlers: ChatStreamHandlers): string {
  let rest = buffer;
  let sepIndex = rest.indexOf("\n\n");
  while (sepIndex !== -1) {
    const frame = rest.slice(0, sepIndex);
    rest = rest.slice(sepIndex + 2);
    parseFrame(frame, handlers);
    sepIndex = rest.indexOf("\n\n");
  }
  return rest;
}

function parseFrame(frame: string, handlers: ChatStreamHandlers): void {
  const dataLines: string[] = [];
  let frameId: string | undefined;
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    } else if (line.startsWith("id:")) {
      frameId = line.slice(3).trim();
    }
  }
  if (dataLines.length === 0) {
    return;
  }
  try {
    const data = JSON.parse(dataLines.join("\n")) as StreamTaskEventEnvelope;
    handlers.onEvent(data, frameId);
  } catch {
    // 忽略无法解析的帧（如心跳）
  }
}
