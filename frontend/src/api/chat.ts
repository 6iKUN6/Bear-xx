import { USE_MOCK, STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { api } from "./generated";

let mockIdCounter = Date.now();

interface ChatTaskResult {
  taskId: string;
  messageId: string;
  status: string;
}

interface StreamPayload {
  taskId?: string;
  messageId?: string;
  delta?: string;
  content?: string;
  message?: string;
}

function genId(): string {
  return "id_" + ++mockIdCounter;
}

const MOCK_REPLIES = [
  "你好！我是 Litter Bear，很高兴为你服务。有什么我可以帮助你的吗？",
  "这是一个很好的问题！让我想想...\n\n根据我的理解，这个问题可以从多个角度来看。首先，我们需要考虑上下文背景，然后再进行深入分析。",
  "好的，我来帮你解答这个问题。希望以下信息对你有帮助！",
  "这个话题很有趣！我可以提供一些相关的见解和建议。",
];

function asStreamPayload(data: unknown): StreamPayload {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as StreamPayload;
    } catch {
      return {};
    }
  }

  if (data && typeof data === "object") {
    return data as StreamPayload;
  }

  return {};
}

export async function getConversations(): Promise<Conversation[]> {
  if (USE_MOCK) {
    return storage.get<Conversation[]>(STORAGE_KEYS.CONVERSATIONS) || [];
  }

  return (await api.findAll()) as Conversation[];
}

export async function createConversation(): Promise<Conversation> {
  if (USE_MOCK) {
    return {
      id: genId(),
      title: "新对话",
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  return (await api.create({})) as Conversation;
}

export async function deleteConversation(id: string): Promise<void> {
  if (USE_MOCK) {
    return;
  }

  await api.delete({ id });
}

export function sendMessage(
  conversationId: string,
  content: string,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
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

  let taskId = "";
  let settled = false;
  let aborted = false;
  let streamHandle: { abort: () => void } | null = null;

  const finishDone = () => {
    if (settled) {
      return;
    }
    settled = true;
    onDone();
  };

  const finishError = (message: string) => {
    if (settled) {
      return;
    }
    settled = true;
    onError(message);
  };

  void api
    .completions({ conversationId, content })
    .then((result) => {
      const task = result as ChatTaskResult;
      if (!task?.taskId) {
        throw new Error("未拿到可恢复的聊天任务 ID");
      }

      taskId = task.taskId;

      if (aborted) {
        streamHandle?.abort();
        void api.cancelTask({ taskId }).catch(() => {});
        return;
      }

      streamHandle = api.resumeTask(
        {
          taskId,
          body: {},
        },
        {
          onMessage(event) {
            const payload = asStreamPayload(event.data);

            if (event.event === "message.delta" && payload.delta) {
              onChunk(payload.delta);
              return;
            }

            if (
              event.event === "message.done" ||
              event.event === "task.completed"
            ) {
              finishDone();
              return;
            }

            if (event.event === "task.error") {
              finishError(payload.message || "聊天任务执行失败");
              return;
            }

            if (event.event === "task.expired") {
              finishError("聊天任务已过期");
              return;
            }

            if (event.event === "task.canceled") {
              finishError("聊天任务已取消");
            }
          },
          onDone() {
            finishDone();
          },
          onError(error) {
            finishError(error.message || "流式请求失败");
          },
        },
      );

      if (aborted) {
        streamHandle.abort();
      }
    })
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "创建聊天任务失败";
      finishError(message);
    });

  return {
    abort() {
      aborted = true;
      streamHandle?.abort();

      if (taskId) {
        void api.cancelTask({ taskId }).catch(() => {});
      }
    },
  };
}
