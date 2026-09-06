import type {
  ApprovalDecisionType,
  ApprovalRequiredPayload,
  PlanReviewRequiredPayload,
} from "@litter-bear/types/protocol";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";
import * as chatApi from "../api/chat";
import type { McDonaldsOrder } from "../api/mcdonaldsOrder";
import { createBoundStore } from "./createBoundStore";
import {
  buildStreamFeedbackFromTrace,
  mergeStreamFeedbackEvent,
} from "../utils/streamFeedback";

/** 本地草稿会话 id 前缀（服务端不存在此记录） */
const DRAFT_CONVERSATION_PREFIX = "draft_";

interface ChatState {
  conversations: Conversation[];
  currentConversation: Conversation | null;

  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;
  setCurrentConversation: (id: string) => void;
  /** 开始新对话：清空当前会话，下一次发送时创建草稿 */
  clearCurrentConversation: () => void;
  /** 服务端创建的会话（单聊/群聊）放入列表并置为当前 */
  upsertConversation: (conversation: Conversation) => void;
  ensureDraftConversation: () => string;
  replaceConversationId: (draftId: string, conversationId: string) => void;
  updateConversationTitle: (conversationId: string, title: string) => void;
  updateConversationModelSelection: (
    conversationId: string,
    fingerprint: string,
  ) => void;

  addMessage: (msg: Message) => void;
  updateMessageContent: (msgId: string, content: string) => void;
  /** 整体替换消息文本（SSE 续接从头重放帧时先清空重建） */
  setMessageContent: (msgId: string, content: string) => void;
  updateMessageStatus: (msgId: string, status: MessageStatus) => void;
  /** 回填本轮真实回答者（群聊自动路由的结果随 task.created 才到） */
  updateMessageSpeaker: (
    msgId: string,
    agentId: string,
    agentName?: string,
  ) => void;
  updateMessageMetrics: (
    msgId: string,
    metrics?: MessageRunMetrics | null,
  ) => void;
  updateMessageStreamEvent: (
    msgId: string,
    event: MessageStreamEventFeedback,
  ) => void;
  toggleMessageStreamFeedback: (msgId: string) => void;
  setMessageApproval: (
    msgId: string,
    payload: ApprovalRequiredPayload | null,
  ) => void;
  /** 工具审批已决定：清空待审批卡，记录决定与原载荷用于单行结论展示 */
  resolveMessageApproval: (
    msgId: string,
    decision: ApprovalDecisionType,
  ) => void;
  setMessagePlanReview: (
    msgId: string,
    payload: PlanReviewRequiredPayload | null,
  ) => void;
  /** 向指定助手消息追加或更新一张订单卡片。 */
  upsertMessageOrder: (msgId: string, order: McDonaldsOrder) => void;

  persistConversations: () => void;
  hydrateConversations: () => void;
}

export const useChatStore = createBoundStore<ChatState>((set, get) => ({
  conversations: [],
  currentConversation: null,

  async loadConversations() {
    const remote = await chatApi.getConversations();
    // 网关异常/被劫持时响应可能不是数组：宁可保留本地数据也不能崩 app
    if (!Array.isArray(remote)) {
      console.warn("loadConversations: 响应不是数组，忽略", remote);
      return;
    }

    set((state) => {
      // 草稿只活在本地（未发送前服务端没有记录），远程列表里不存在，
      // 直接整体覆盖会把它连同用户已输入的上下文一起丢掉。
      const drafts = state.conversations.filter((c) => isDraftConversation(c.id));
      const conversations = [
        ...drafts,
        ...remote.map(normalizeConversationStreamFeedback),
      ];

      const current = state.currentConversation;
      if (!current) {
        return { conversations };
      }

      // 流式进行中不能用远程覆盖：服务端此刻的消息落后于正在增量拼接的本地内容，
      // 覆盖会把已经渲染出来的半截回答抹掉。草稿同理，远程没有对应记录。
      const hasInFlight = current.messages.some((m) => m.status === "streaming");
      if (hasInFlight || isDraftConversation(current.id)) {
        return { conversations };
      }

      // 重新指向刷新后的对象。不这样做，当前会话会一直停在 hydrate 时的旧快照，
      // 本地残留（例如请求失败留下的占位消息）永远等不到服务端数据来纠正——
      // 表现为切走再切回来才恢复正常。
      const refreshed = conversations.find((c) => c.id === current.id);
      return {
        conversations,
        // 远端已不存在（在别处删了）时保留当前对象，避免视图突然空掉
        currentConversation: refreshed ?? current,
      };
    });
  },

  async createConversation() {
    const conv = await chatApi.createConversation();
    set((state) => ({
      conversations: [conv, ...state.conversations],
      currentConversation: conv,
    }));
    get().persistConversations();
    return conv.id;
  },

  async deleteConversation(id: string) {
    await chatApi.deleteConversation(id);
    set((state) => {
      const conversations = state.conversations.filter((c) => c.id !== id);
      const currentConversation =
        state.currentConversation?.id === id ? null : state.currentConversation;
      return { conversations, currentConversation };
    });
    get().persistConversations();
  },

  setCurrentConversation(id: string) {
    const conv = get().conversations.find((c) => c.id === id) || null;
    set({ currentConversation: conv });
  },

  clearCurrentConversation() {
    set({ currentConversation: null });
  },

  upsertConversation(conversation: Conversation) {
    set((state) => {
      const exists = state.conversations.some((c) => c.id === conversation.id);
      const normalized = { ...conversation, messages: conversation.messages ?? [] };
      const conversations = exists
        ? state.conversations.map((c) =>
            c.id === normalized.id ? { ...c, ...normalized, messages: c.messages } : c,
          )
        : [normalized, ...state.conversations];
      const currentConversation = exists
        ? (conversations.find((c) => c.id === normalized.id) ?? null)
        : normalized;
      return { conversations, currentConversation };
    });
    get().persistConversations();
  },

  ensureDraftConversation() {
    const currentConversation = get().currentConversation;
    if (currentConversation) {
      return currentConversation.id;
    }

    const now = Date.now();
    const draftConversation: Conversation = {
      id: `${DRAFT_CONVERSATION_PREFIX}${now}`,
      title: "新对话",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    set((state) => ({
      conversations: [draftConversation, ...state.conversations],
      currentConversation: draftConversation,
    }));

    return draftConversation.id;
  },

  replaceConversationId(draftId: string, conversationId: string) {
    set((state) => {
      const conversations = state.conversations.map((conversation) =>
        conversation.id === draftId
          ? { ...conversation, id: conversationId }
          : conversation,
      );
      const currentConversation =
        state.currentConversation?.id === draftId
          ? { ...state.currentConversation, id: conversationId }
          : state.currentConversation;

      return { conversations, currentConversation };
    });
  },

  updateConversationTitle(conversationId: string, title: string) {
    set((state) => {
      const conversations = state.conversations.map((c) =>
        c.id === conversationId ? { ...c, title } : c,
      );
      const currentConversation =
        state.currentConversation?.id === conversationId
          ? { ...state.currentConversation, title }
          : state.currentConversation;

      return { conversations, currentConversation };
    });
  },

  updateConversationModelSelection(conversationId, fingerprint) {
    set((state) => {
      const conversations = state.conversations.map((conversation) =>
        conversation.id === conversationId
          ? { ...conversation, lastModelSelectionFingerprint: fingerprint }
          : conversation,
      );
      return {
        conversations,
        currentConversation:
          state.currentConversation?.id === conversationId
            ? {
                ...state.currentConversation,
                lastModelSelectionFingerprint: fingerprint,
              }
            : state.currentConversation,
      };
    });
  },

  addMessage(msg: Message) {
    set((state) => {
      if (!state.currentConversation) return state;

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages: [...state.currentConversation.messages, msg],
        updatedAt: Date.now(),
        // 用第一条用户消息作为标题
        title:
          state.currentConversation.messages.length === 0 && msg.role === "user"
            ? msg.content.slice(0, 20)
            : state.currentConversation.title,
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageContent(msgId: string, content: string) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, content: m.content + content } : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  setMessageContent(msgId: string, content: string) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, content } : m,
      );
      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };
      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageStatus(msgId: string, status: MessageStatus) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId
          ? {
              ...m,
              status,
              // 收敛到终态就意味着这轮不会再有回答者被指派了。
              // 不清会留下 routing=true 的幽灵消息：发送失败（task.created 从未到达，
              // updateMessageSpeaker 也就没机会执行）后永久显示「正在指派…」。
              ...(status === "done" || status === "error"
                ? { routing: false }
                : {}),
            }
          : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageSpeaker(msgId: string, agentId: string, agentName?: string) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId
          ? {
              ...m,
              agentId,
              ...(agentName ? { agentName } : {}),
              // 指派已落定，撤下「正在指派…」
              routing: false,
            }
          : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageMetrics(msgId: string, metrics?: MessageRunMetrics | null) {
    if (!metrics) {
      return;
    }

    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, metrics } : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageStreamEvent(msgId: string, event: MessageStreamEventFeedback) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? applyStreamFeedbackEvent(m, event) : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  toggleMessageStreamFeedback(msgId: string) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) => {
        if (m.id !== msgId) {
          return m;
        }

        const streamFeedback = normalizeStreamFeedback(m);
        return {
          ...m,
          streamFeedback: {
            ...streamFeedback,
            expanded: !streamFeedback.expanded,
          },
        };
      });

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  setMessageApproval(msgId: string, payload: ApprovalRequiredPayload | null) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, pendingApproval: payload ?? undefined } : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  resolveMessageApproval(msgId: string, decision: ApprovalDecisionType) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) => {
        if (m.id !== msgId || !m.pendingApproval) return m;
        return {
          ...m,
          pendingApproval: undefined,
          resolvedApproval: { decision, payload: m.pendingApproval },
        };
      });

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  setMessagePlanReview(
    msgId: string,
    payload: PlanReviewRequiredPayload | null,
  ) {    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, pendingPlanReview: payload ?? undefined } : m,
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  upsertMessageOrder(msgId: string, order: McDonaldsOrder) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((message) => {
        if (message.id !== msgId) {
          return message;
        }

        const orders = message.orders ?? [];
        const exists = orders.some((item) => item.id === order.id);
        return {
          ...message,
          orders: exists
            ? orders.map((item) => (item.id === order.id ? order : item))
            : [...orders, order],
        };
      });
      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };
      const conversations = state.conversations.map((conversation) =>
        conversation.id === updatedConv.id ? updatedConv : conversation,
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  persistConversations() {
    const { conversations } = get();
    storage.set(STORAGE_KEYS.CONVERSATIONS, conversations);
  },

  hydrateConversations() {
    const conversations =
      storage.get<Conversation[]>(STORAGE_KEYS.CONVERSATIONS) || [];
    set({
      conversations: conversations.map(normalizeConversationStreamFeedback),
    });
  },
}));

/**
 * 判断是否为本地草稿会话
 * @description 草稿在首次发送前只存在于本地，服务端没有对应记录，
 * 因此不能参与任何「以远程列表为准」的覆盖逻辑。
 */
function isDraftConversation(conversationId: string) {
  return conversationId.startsWith(DRAFT_CONVERSATION_PREFIX);
}

function normalizeConversationStreamFeedback(
  conversation: Conversation,
): Conversation {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).map(normalizeMessageStreamFeedback),
  };
}

function normalizeMessageStreamFeedback(message: Message): Message {
  // 落盘的 routing=true 必然是残留：指派一旦落定就随 task.created 走
  // updateMessageSpeaker 清掉，能被持久化下来说明那条请求压根没建起任务，
  // 重启后也不存在可续接的目标。留着会一直显示「正在指派…」。
  const base = message.routing ? { ...message, routing: false } : message;

  if (
    base.role !== "assistant" ||
    base.streamFeedback ||
    base.currentStreamEvent ||
    !base.trace?.length
  ) {
    return base;
  }

  const streamFeedback = buildStreamFeedbackFromTrace(base.trace);
  if (!streamFeedback) {
    return base;
  }

  return {
    ...base,
    currentStreamEvent: streamFeedback.current,
    streamFeedback,
  };
}

function applyStreamFeedbackEvent(
  message: Message,
  event: MessageStreamEventFeedback,
): Message {
  const streamFeedback = normalizeStreamFeedback(message);
  const events = upsertStreamFeedbackEvent(streamFeedback.events, event);

  return {
    ...message,
    currentStreamEvent: event,
    streamFeedback: {
      ...streamFeedback,
      current: event,
      events,
    },
  };
}

function normalizeStreamFeedback(message: Message): MessageStreamFeedbackState {
  if (message.streamFeedback) {
    return message.streamFeedback;
  }

  const event = message.currentStreamEvent;
  return {
    current: event,
    events: event ? [event] : [],
    expanded: false,
  };
}

function upsertStreamFeedbackEvent(
  events: MessageStreamEventFeedback[],
  nextEvent: MessageStreamEventFeedback,
) {
  const matchedIndex = events.findIndex((event) =>
    isSameStreamFeedbackStep(event, nextEvent),
  );

  if (matchedIndex < 0) {
    return [...events, nextEvent];
  }

  return events.map((event, index) =>
    index === matchedIndex ? mergeStreamFeedbackEvent(event, nextEvent) : event,
  );
}

function isSameStreamFeedbackStep(
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
