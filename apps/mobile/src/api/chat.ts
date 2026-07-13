import { USE_MOCK, STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { api } from "./generated";

let mockIdCounter = Date.now();

interface ChatTaskResult {
  taskId: string;
  messageId: string;
  conversationId: string;
  status: string;
}

interface ChatStreamEnvelope<TPayload = undefined> {
  type?: string;
  taskId?: string;
  conversationId?: string;
  messageId?: string;
  status?: string;
  payload?: TPayload;
  errorMessage?: string;
}

interface MessageDeltaPayload {
  delta?: string;
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

function asStreamPayload<TPayload = undefined>(
  data: unknown,
): ChatStreamEnvelope<TPayload> {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as ChatStreamEnvelope<TPayload>;
    } catch {
      return {};
    }
  }

  if (data && typeof data === "object") {
    return data as ChatStreamEnvelope<TPayload>;
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
  conversationId: string | undefined,
  content: string,
  onTaskCreated: (task: ChatTaskResult) => void,
  onChunk: (text: string) => void,
  onDone: () => void,
  onError: (err: string) => void,
): { abort: () => void } {
  if (USE_MOCK) {
    onTaskCreated({
      taskId: genId(),
      messageId: genId(),
      conversationId: conversationId || genId(),
      status: "pending",
    });

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

  const streamHandle = api.sendMessage(
    { conversationId, content },
    {
      onMessage(event) {
        const payload = asStreamPayload(event.data);

        if (event.event === "task.created") {
          const task: ChatTaskResult = {
            taskId: payload.taskId || "",
            messageId: payload.messageId || "",
            conversationId: payload.conversationId || "",
            status: payload.status || "",
          };
          if (!task?.taskId || !task?.conversationId) {
            finishError("未拿到可恢复的聊天任务 ID");
            return;
          }

          taskId = task.taskId;
          onTaskCreated(task);

          if (aborted) {
            streamHandle.abort();
            void api.cancelTask({ taskId }).catch(() => {});
          }
          return;
        }

        if (event.event === "message.delta") {
          const deltaPayload = payload.payload as MessageDeltaPayload | undefined;
          if (deltaPayload?.delta) {
            onChunk(deltaPayload.delta);
          }
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
          finishError(payload.errorMessage || "聊天任务执行失败");
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
    }
  );

  return {
    abort() {
      aborted = true;
      streamHandle.abort();

      if (taskId) {
        void api.cancelTask({ taskId }).catch(() => {});
      }
    },
  };
}
