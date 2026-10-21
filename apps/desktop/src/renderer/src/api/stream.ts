import type {
  ApprovalDecision,
  PlanReviewDecision,
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
 * SSE 请求失败
 * @description retryable 区分「连接问题，可用同一 taskId 续接」与「请求本身被拒绝」：
 * 网络中断、空闲超时、429 与 5xx 可续接；401 与其余 4xx 重试不会变好，直接报错。
 */
export class StreamRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StreamRequestError";
  }
}

/**
 * 连接空闲上限：服务端每 15s 发一次心跳，超过 3 个心跳周期没有任何字节，
 * 视为半开连接（休眠唤醒、切换网络后常见），主动断开交给上层续接。
 */
const STREAM_IDLE_TIMEOUT_MS = 45_000;

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
 * 提交工具审批决定并续跑（POST /stream-tasks/:taskId/approval，HITL）
 * @description 审批端点同样是 SSE：决定落库后经 Temporal 恢复，任务从中断处继续推流，
 * 复用同一套帧解析与事件回调。approvalId 来自 flow.waiting_human，lastEventId 传断点游标，服务端只补新帧。
 */
export function streamApproval(
  taskId: string,
  approvalId: string,
  decision: ApprovalDecision,
  lastEventId: string | undefined,
  handlers: ChatStreamHandlers,
): StreamHandle {
  return openSseStream(
    `/api/stream-tasks/${encodeURIComponent(taskId)}/approval`,
    { ...decision, approvalId, lastEventId },
    handlers,
    "提交审批失败",
  );
}

/**
 * 提交计划审批决定并续跑（POST /stream-tasks/:taskId/plan-review，HITL）
 * @description 与工具审批共用续跑管道，只是决定闭集不同（通过 / 修改 / 打回重规划 / 终止）。
 */
export function streamPlanReview(
  taskId: string,
  approvalId: string,
  decision: PlanReviewDecision,
  lastEventId: string | undefined,
  handlers: ChatStreamHandlers,
): StreamHandle {
  return openSseStream(
    `/api/stream-tasks/${encodeURIComponent(taskId)}/plan-review`,
    { ...decision, approvalId, lastEventId },
    handlers,
    "提交计划确认失败",
  );
}

/**
 * 续接进行中的任务流（POST /stream-tasks/:taskId/resume）
 * @description 服务端先重放 lastEventId 之后的缓冲帧，再接实时帧；任务已终态时直接下发终态。
 * 用于断线重连与重启后恢复，不会重新触发模型调用。
 */
export function resumeTaskStream(
  taskId: string,
  lastEventId: string,
  handlers: ChatStreamHandlers,
): StreamHandle {
  return openSseStream(
    `/api/stream-tasks/${encodeURIComponent(taskId)}/resume`,
    { lastEventId },
    handlers,
    "恢复连接失败",
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
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleExpired = false;
  const armIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleExpired = true;
      controller.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  void (async () => {
    try {
      armIdleTimer();
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
        throw new StreamRequestError("登录已过期，请重新登录", false);
      }
      if (!response.ok || !response.body) {
        throw new StreamRequestError(
          `${failureLabel}（${response.status}）`,
          response.status === 429 || response.status >= 500,
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        armIdleTimer();
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        buffer = consumeFrames(buffer, handlers);
      }
      handlers.onDone();
    } catch (error) {
      if (idleExpired) {
        handlers.onError(
          new StreamRequestError("连接长时间无响应，已断开", true),
        );
        return;
      }
      if (controller.signal.aborted) {
        return;
      }
      handlers.onError(
        error instanceof StreamRequestError
          ? error
          : // fetch 层抛出的都是网络问题（断网、连接被重置、DNS 失败），可续接
            new StreamRequestError(
              error instanceof Error ? error.message : String(error),
              true,
            ),
      );
    } finally {
      clearTimeout(idleTimer);
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
