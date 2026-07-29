import { authStorage } from "./auth-storage";
import type { StreamTaskEventEnvelope } from "@litter-bear/types/protocol";

const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000"
).replace(/\/+$/, "");

export interface AgentTestBody {
  content: string;
  /** 传入则续接该测试会话（多轮记忆）；不传新建 */
  conversationId?: string;
  agentId?: string;
  modelPreset?: string;
}

export interface AgentTestHandlers {
  onEvent: (eventName: string, data: StreamTaskEventEnvelope) => void;
  onError: (error: Error) => void;
  onDone: () => void;
}

/**
 * 发起 admin 流式测试
 * @description 用 fetch + ReadableStream 带 Bearer 消费 SSE（EventSource 无法带 Authorization）。
 * 逐帧解析 `event:`/`data:`，回调 onEvent。返回一个可 abort 的句柄。
 */
export function streamAgentTest(
  body: AgentTestBody,
  handlers: AgentTestHandlers,
): { abort: () => void } {
  const controller = new AbortController();
  const token = authStorage.getToken();

  void (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/admin/agent-tests`, {
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
        throw new Error("登录已过期，请重新登录");
      }
      if (response.status === 403) {
        throw new Error("无管理员权限");
      }
      if (!response.ok || !response.body) {
        throw new Error(`测试请求失败（${response.status}）`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
        buffer = consumeFrames(buffer, handlers);
      }
      handlers.onDone();
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  })();

  return { abort: () => controller.abort() };
}

/** 按空行分割 SSE 帧，解析 event:/data:，返回剩余未完整的 buffer */
function consumeFrames(buffer: string, handlers: AgentTestHandlers): string {
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

function parseFrame(frame: string, handlers: AgentTestHandlers): void {
  let eventName = "message";
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (dataLines.length === 0) return;
  try {
    const data = JSON.parse(dataLines.join("\n")) as StreamTaskEventEnvelope;
    handlers.onEvent(eventName, data);
  } catch {
    // 忽略无法解析的帧（如心跳）
  }
}
