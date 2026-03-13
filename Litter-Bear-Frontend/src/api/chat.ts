import Taro from "@tarojs/taro";
import { API_BASE_URL, USE_MOCK, STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { get, post } from "./request";

let mockIdCounter = Date.now();
function genId(): string {
  return "id_" + ++mockIdCounter;
}

const MOCK_REPLIES = [
  "你好！我是 Litter Bear，很高兴为你服务。有什么我可以帮助你的吗？",
  "这是一个很好的问题！让我想想...\n\n根据我的理解，这个问题可以从多个角度来看。首先，我们需要考虑上下文背景，然后再进行深入分析。",
  "好的，我来帮你解答这个问题。希望以下信息对你有帮助！",
  "这个话题很有趣！我可以提供一些相关的见解和建议。",
];

export async function getConversations(): Promise<Conversation[]> {
  if (USE_MOCK) {
    return storage.get<Conversation[]>(STORAGE_KEYS.CONVERSATIONS) || [];
  }
  return get<Conversation[]>("/conversations");
}

export async function createConversation(): Promise<Conversation> {
  if (USE_MOCK) {
    const conv: Conversation = {
      id: genId(),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return conv;
  }
  return post<Conversation>("/conversations");
}

export async function deleteConversation(id: string): Promise<void> {
  if (USE_MOCK) {
    return;
  }
  await post("/conversations/delete", { id });
}

export function sendMessage(
  _conversationId: string,
  content: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void
): { abort: () => void } {
  if (USE_MOCK) {
    const reply =
      MOCK_REPLIES[Math.floor(Math.random() * MOCK_REPLIES.length)];
    let index = 0;
    let aborted = false;

    const timer = setInterval(() => {
      if (aborted) {
        clearInterval(timer);
        return;
      }
      if (index < reply.length) {
        onChunk(reply[index]);
        index++;
      } else {
        clearInterval(timer);
        onDone();
      }
    }, 50);

    return {
      abort() {
        aborted = true;
        clearInterval(timer);
      },
    };
  }

  // 真实模式：HTTP Chunked 流式请求
  const token = storage.get<string>(STORAGE_KEYS.TOKEN);
  const requestTask = Taro.request({
    url: `${API_BASE_URL}/chat/completions`,
    method: "POST",
    enableChunked: true,
    header: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    data: { conversationId: _conversationId, content },
    success() {
      onDone();
    },
    fail(err) {
      onError(err.errMsg || "请求失败");
    },
  });

  requestTask.onChunkReceived?.((res) => {
    try {
      const text = arrayBufferToString(res.data as ArrayBuffer);
      // 解析 SSE 格式数据
      const lines = text.split("\n");
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            onDone();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.choices?.[0]?.delta?.content;
            if (chunk) {
              onChunk(chunk);
            }
          } catch {
            // 非 JSON 行，忽略
          }
        }
      }
    } catch {
      // 解析异常，忽略
    }
  });

  return {
    abort() {
      requestTask.abort();
    },
  };
}

function arrayBufferToString(buffer: ArrayBuffer): string {
  const uint8Array = new Uint8Array(buffer);
  let result = "";
  for (let i = 0; i < uint8Array.length; i++) {
    result += String.fromCharCode(uint8Array[i]);
  }
  try {
    return decodeURIComponent(escape(result));
  } catch {
    return result;
  }
}
