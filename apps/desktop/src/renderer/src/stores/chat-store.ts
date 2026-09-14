import { create } from "zustand";
import {
  buildStreamFeedbackFromTrace,
  mergeStreamFeedbackEvent,
  toMessageStreamFeedback,
  type MessageRunMetrics,
  type MessageStreamEventFeedback,
  type MessageStreamFeedbackState,
  type StreamTaskEvent,
} from "@litter-bear/chat-core";
import {
  STREAM_TASK_EVENT_LABELS,
  StreamTaskEventType,
  type ApprovalDecision,
  type ApprovalRequiredPayload,
  type ApprovalResolvedPayload,
  type ConversationTitleUpdatedPayload,
  type MessageDeltaPayload,
  type MessageDonePayload,
  type StreamTaskEventEnvelope,
} from "@litter-bear/types/protocol";
import { getConversations } from "@/api/endpoints";
import { streamApproval, streamChatMessage } from "@/api/stream";
import type { Conversation, ConversationMessage } from "@/api/types";
import type { ReasoningSelection } from "@litter-bear/types";

/** 发送一条消息的可选项：智能体、模型与思考设置 */
export interface SendOptions {
  /** 指定使用的智能体 id；不传则用会话默认 / 内置智能体 */
  agentId?: string | null;
  /** 本条消息选择的模型预设业务 ID */
  selectedModelPresetId?: string;
  /** 本轮思考设置（仅 direct Agent 可用） */
  reasoning?: ReasoningSelection;
}

/**
 * 会话与消息：GET /conversations 拉取，POST /chat/message（SSE）发送并流式更新。
 * 执行轨迹（trace）与 HITL 审批卡复用 @litter-bear/chat-core 的折叠/构建逻辑：
 * 实时事件经 toMessageStreamFeedback 折叠进 message.streamFeedback，
 * 历史回显由 buildStreamFeedbackFromTrace(message.trace) 构建。
 */
interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  loading: boolean;
  /** 会话列表加载失败文案；null = 正常 */
  loadError: string | null;
  sending: boolean;
  /** 审批提交中（禁用审批卡交互，避免重复提交） */
  approvalSubmitting: boolean;
  loadConversations: () => Promise<void>;
  setActive: (id: string | null) => void;
  send: (content: string, options?: SendOptions) => void;
  /** 展开 / 收起某条消息的执行轨迹 */
  toggleStreamFeedback: (messageId: string) => void;
  /** 提交人工审批决定（HITL），审批端点续跑同一任务 */
  submitApproval: (messageId: string, decision: ApprovalDecision) => void;
  /** 退出登录 / 清理本地会话态 */
  reset: () => void;
}

let localSeq = 0;
function localId(prefix: string) {
  localSeq += 1;
  return `local-${prefix}-${Date.now()}-${localSeq}`;
}

/**
 * 当前活动流的上下文：一次发送（及可能的审批续跑）共享同一条助手消息。
 * 桌面端同一时间只有一条活动流，用模块级引用即可，无需进 store。
 */
interface ActiveStreamContext {
  assistantMessageId: string;
  taskId?: string;
  lastEventId?: string;
}
let activeStream: ActiveStreamContext | null = null;

function patchMessage(
  conversations: Conversation[],
  messageId: string,
  patch: (m: ConversationMessage) => ConversationMessage,
): Conversation[] {
  return conversations.map((c) =>
    c.messages.some((m) => m.id === messageId)
      ? { ...c, messages: c.messages.map((m) => (m.id === messageId ? patch(m) : m)) }
      : c,
  );
}

/** 线上信封 → chat-core 的 StreamTaskEvent 形状（data 即信封本体，含 payload） */
function toStreamTaskEvent(envelope: StreamTaskEventEnvelope): StreamTaskEvent {
  return {
    type: envelope.type,
    data: { ...envelope, type: envelope.type },
    rawData: JSON.stringify(envelope),
  };
}

/** 同一逻辑步骤（工具 / Flow 节点生命周期）按 id 或内容指纹折叠进同一条反馈 */
function isSameFeedbackStep(
  event: MessageStreamEventFeedback,
  nextEvent: MessageStreamEventFeedback,
) {
  return (
    event.id === nextEvent.id ||
    (event.type === nextEvent.type &&
      event.title === nextEvent.title &&
      event.detail === nextEvent.detail)
  );
}

function upsertFeedbackEvent(
  events: MessageStreamEventFeedback[],
  nextEvent: MessageStreamEventFeedback,
) {
  const matchedIndex = events.findIndex((event) =>
    isSameFeedbackStep(event, nextEvent),
  );
  if (matchedIndex < 0) {
    return [...events, nextEvent];
  }
  return events.map((event, index) =>
    index === matchedIndex ? mergeStreamFeedbackEvent(event, nextEvent) : event,
  );
}

function applyFeedbackEvent(
  message: ConversationMessage,
  event: MessageStreamEventFeedback,
): ConversationMessage {
  const prev: MessageStreamFeedbackState = message.streamFeedback ?? {
    events: [],
    expanded: false,
  };
  return {
    ...message,
    streamFeedback: {
      ...prev,
      current: event,
      events: upsertFeedbackEvent(prev.events, event),
    },
  };
}

/** 历史回显：助手消息有 trace 但还没有 streamFeedback 时，从 trace 构建折叠轨迹 */
function withHistoryFeedback(message: ConversationMessage): ConversationMessage {
  if (
    message.role !== "assistant" ||
    message.streamFeedback ||
    !message.trace?.length
  ) {
    return message;
  }
  const streamFeedback = buildStreamFeedbackFromTrace(message.trace);
  return streamFeedback ? { ...message, streamFeedback } : message;
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  loading: false,
  loadError: null,
  sending: false,
  approvalSubmitting: false,

  async loadConversations() {
    set({ loading: true, loadError: null });
    try {
      const remote = await getConversations();
      const conversations = [...remote]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((c) => ({ ...c, messages: c.messages.map(withHistoryFeedback) }));
      set((state) => ({
        conversations,
        loading: false,
        // 当前会话被删或从未选择时，落到空状态，不自动选中
        activeId:
          state.activeId && conversations.some((c) => c.id === state.activeId)
            ? state.activeId
            : null,
      }));
    } catch (error) {
      set({
        loading: false,
        loadError: error instanceof Error ? error.message : "会话加载失败",
      });
    }
  },

  setActive(id) {
    set({ activeId: id });
  },

  toggleStreamFeedback(messageId) {
    set((state) => ({
      conversations: patchMessage(state.conversations, messageId, (m) =>
        m.streamFeedback
          ? {
              ...m,
              streamFeedback: {
                ...m.streamFeedback,
                expanded: !m.streamFeedback.expanded,
              },
            }
          : m,
      ),
    }));
  },

  send(content, options) {
    const text = content.trim();
    if (!text || get().sending) {
      return;
    }

    const userMessage: ConversationMessage = {
      id: localId("u"),
      role: "user",
      content: text,
      status: "done",
      createdAt: Date.now(),
    };
    const assistantMessage: ConversationMessage = {
      id: localId("a"),
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
    };

    // 乐观上屏：无当前会话时先立本地占位会话，等流里带回真实 conversationId 再换
    const draftConvId = get().activeId ?? localId("c");
    set((state) => {
      const conversations = [...state.conversations];
      let conv = conversations.find((c) => c.id === state.activeId);
      if (!conv) {
        conv = {
          id: draftConvId,
          title: text.slice(0, 18),
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        conversations.unshift(conv);
      }
      conv.messages = [...conv.messages, userMessage, assistantMessage];
      conv.updatedAt = Date.now();
      return { conversations, activeId: draftConvId, sending: true };
    });

    activeStream = { assistantMessageId: assistantMessage.id };

    const handleEvent = (
      event: StreamTaskEventEnvelope,
      frameId?: string,
    ) => {
      if (activeStream) {
        if (event.taskId) {
          activeStream.taskId = event.taskId;
        }
        if (frameId) {
          activeStream.lastEventId = frameId;
        }
      }

      // 流里的真实 conversationId 到位后，把本地占位会话换成服务端会话
      if (event.conversationId) {
        set((state) => {
          if (!state.conversations.some((c) => c.id === draftConvId)) {
            return state;
          }
          if (event.conversationId === draftConvId) {
            return state;
          }
          return {
            conversations: state.conversations.map((c) =>
              c.id === draftConvId ? { ...c, id: event.conversationId! } : c,
            ),
            activeId:
              state.activeId === draftConvId ? event.conversationId! : state.activeId,
          };
        });
      }

      // 执行轨迹：除文本/工具入参分片外的事件折叠进反馈状态（toMessageStreamFeedback 内部已过滤）
      const feedback = toMessageStreamFeedback(toStreamTaskEvent(event));
      if (feedback) {
        set((state) => ({
          conversations: patchMessage(
            state.conversations,
            assistantMessage.id,
            (m) => applyFeedbackEvent(m, feedback),
          ),
        }));
      }

      switch (event.type) {
        case StreamTaskEventType.MessageDelta: {
          const delta = (event.payload as MessageDeltaPayload | undefined)?.delta ?? "";
          if (!delta) {
            return;
          }
          set((state) => ({
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) => ({
              ...m,
              content: m.content + delta,
            })),
          }));
          return;
        }
        case StreamTaskEventType.ConversationTitleUpdated: {
          const payload = event.payload as ConversationTitleUpdatedPayload | undefined;
          if (!payload?.title) {
            return;
          }
          set((state) => ({
            conversations: state.conversations.map((c) =>
              c.id === payload.conversationId ? { ...c, title: payload.title } : c,
            ),
          }));
          return;
        }
        case StreamTaskEventType.ApprovalRequired: {
          const payload = event.payload as ApprovalRequiredPayload | undefined;
          if (!payload) {
            return;
          }
          set((state) => ({
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) => ({
              ...m,
              pendingApproval: payload,
            })),
          }));
          return;
        }
        case StreamTaskEventType.ApprovalResolved: {
          const payload = event.payload as ApprovalResolvedPayload | undefined;
          set((state) => ({
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) => {
              if (!m.pendingApproval) {
                return m;
              }
              return {
                ...m,
                pendingApproval: undefined,
                resolvedApproval: payload
                  ? { decision: payload.decision, payload: m.pendingApproval }
                  : undefined,
              };
            }),
          }));
          return;
        }
        case StreamTaskEventType.MessageDone: {
          const metrics = (event.payload as MessageDonePayload | undefined)?.metrics;
          // HITL 挂起时不会发 message.done（任务提前 return），收到即代表本轮真正结束
          set((state) => ({
            sending: false,
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) => ({
              ...m,
              status: m.status === "streaming" ? "done" : m.status,
              metrics: (metrics as MessageRunMetrics | undefined) ?? m.metrics,
            })),
          }));
          return;
        }
        case StreamTaskEventType.TaskCompleted: {
          set((state) => ({
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) =>
              m.status === "streaming" && !m.pendingApproval ? { ...m, status: "done" } : m,
            ),
          }));
          return;
        }
        case StreamTaskEventType.TaskError: {
          set((state) => ({
            sending: false,
            conversations: patchMessage(state.conversations, assistantMessage.id, (m) => ({
              ...m,
              status: "error",
              content:
                m.content ||
                STREAM_TASK_EVENT_LABELS[StreamTaskEventType.TaskError],
            })),
          }));
          return;
        }
        default:
          return;
      }
    };

    const handleError = (error: Error) => {
      set((state) => ({
        sending: false,
        approvalSubmitting: false,
        conversations: patchMessage(state.conversations, assistantMessage.id, (m) => ({
          ...m,
          status: "error",
          content: m.content || error.message,
        })),
      }));
      activeStream = null;
    };

    const handleDone = () => {
      // 等待人工审批时任务挂起、流先结束：保持 streaming 与 sending，等审批续跑
      const pending = get()
        .conversations.flatMap((c) => c.messages)
        .find((m) => m.id === assistantMessage.id)?.pendingApproval;
      if (pending) {
        return;
      }
      set({ sending: false });
      activeStream = null;
      // 以服务端为最终事实源同步一次（真实消息 id、标题、updatedAt 排序）
      void get().loadConversations();
    };

    streamChatMessage(
      {
        conversationId: get().activeId?.startsWith("local-")
          ? undefined
          : (get().activeId ?? undefined),
        content: text,
        agentId: options?.agentId ?? undefined,
        selectedModelPresetId: options?.selectedModelPresetId,
        reasoning: options?.reasoning,
      },
      { onEvent: handleEvent, onError: handleError, onDone: handleDone },
    );
  },

  submitApproval(messageId, decision) {
    const taskId = activeStream?.taskId;
    const lastEventId = activeStream?.lastEventId;
    if (!taskId || get().approvalSubmitting) {
      return;
    }

    const message = get()
      .conversations.flatMap((c) => c.messages)
      .find((m) => m.id === messageId);
    if (!message?.pendingApproval) {
      return;
    }

    // 本地先收敛成已决定 + 回到 streaming，等续跑流的事件推进
    set((state) => ({
      approvalSubmitting: true,
      conversations: patchMessage(state.conversations, messageId, (m) => ({
        ...m,
        status: "streaming",
        pendingApproval: undefined,
        resolvedApproval: m.pendingApproval
          ? { decision: decision.decision, payload: m.pendingApproval }
          : undefined,
      })),
    }));

    const handleEvent = (
      event: StreamTaskEventEnvelope,
      frameId?: string,
    ) => {
      if (activeStream) {
        if (event.taskId) {
          activeStream.taskId = event.taskId;
        }
        if (frameId) {
          activeStream.lastEventId = frameId;
        }
      }

      const feedback = toMessageStreamFeedback(toStreamTaskEvent(event));
      if (feedback) {
        set((state) => ({
          conversations: patchMessage(state.conversations, messageId, (m) =>
            applyFeedbackEvent(m, feedback),
          ),
        }));
      }

      switch (event.type) {
        case StreamTaskEventType.MessageDelta: {
          const delta = (event.payload as MessageDeltaPayload | undefined)?.delta ?? "";
          if (!delta) {
            return;
          }
          set((state) => ({
            conversations: patchMessage(state.conversations, messageId, (m) => ({
              ...m,
              content: m.content + delta,
            })),
          }));
          return;
        }
        case StreamTaskEventType.MessageDone: {
          const metrics = (event.payload as MessageDonePayload | undefined)?.metrics;
          set((state) => ({
            conversations: patchMessage(state.conversations, messageId, (m) => ({
              ...m,
              status: m.status === "streaming" ? "done" : m.status,
              metrics: (metrics as MessageRunMetrics | undefined) ?? m.metrics,
            })),
          }));
          return;
        }
        case StreamTaskEventType.TaskCompleted: {
          set((state) => ({
            conversations: patchMessage(state.conversations, messageId, (m) =>
              m.status === "streaming" ? { ...m, status: "done" } : m,
            ),
          }));
          return;
        }
        case StreamTaskEventType.TaskError: {
          set((state) => ({
            sending: false,
            approvalSubmitting: false,
            conversations: patchMessage(state.conversations, messageId, (m) => ({
              ...m,
              status: "error",
              content:
                m.content ||
                STREAM_TASK_EVENT_LABELS[StreamTaskEventType.TaskError],
            })),
          }));
          return;
        }
        default:
          return;
      }
    };

    streamApproval(taskId, decision, lastEventId, {
      onEvent: handleEvent,
      onError: (error) => {
        set((state) => ({
          sending: false,
          approvalSubmitting: false,
          conversations: patchMessage(state.conversations, messageId, (m) => ({
            ...m,
            status: "error",
            content: m.content || error.message,
          })),
        }));
        activeStream = null;
      },
      onDone: () => {
        set({ sending: false, approvalSubmitting: false });
        activeStream = null;
        void get().loadConversations();
      },
    });
  },

  reset() {
    activeStream = null;
    set({
      conversations: [],
      activeId: null,
      loading: false,
      loadError: null,
      sending: false,
      approvalSubmitting: false,
    });
  },
}));
