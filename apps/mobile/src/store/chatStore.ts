import type { ApprovalRequiredPayload } from "@litter-bear/types/protocol";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";
import * as chatApi from "../api/chat";
import { createBoundStore } from "./createBoundStore";
import { buildStreamFeedbackFromTrace } from "../utils/streamFeedback";

interface ChatState {
  conversations: Conversation[];
  currentConversation: Conversation | null;

  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;
  setCurrentConversation: (id: string) => void;
  /** 开始新对话：清空当前会话，下一次发送时创建草稿 */
  clearCurrentConversation: () => void;
  ensureDraftConversation: () => string;
  replaceConversationId: (draftId: string, conversationId: string) => void;
  updateConversationTitle: (conversationId: string, title: string) => void;

  addMessage: (msg: Message) => void;
  updateMessageContent: (msgId: string, content: string) => void;
  /** 整体替换消息文本（SSE 续接从头重放帧时先清空重建） */
  setMessageContent: (msgId: string, content: string) => void;
  updateMessageStatus: (msgId: string, status: MessageStatus) => void;
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

  persistConversations: () => void;
  hydrateConversations: () => void;
}

export const useChatStore = createBoundStore<ChatState>((set, get) => ({
  conversations: [],
  currentConversation: null,

  async loadConversations() {
    const conversations = await chatApi.getConversations();
    // 网关异常/被劫持时响应可能不是数组：宁可保留本地数据也不能崩 app
    if (!Array.isArray(conversations)) {
      console.warn("loadConversations: 响应不是数组，忽略", conversations);
      return;
    }
    set({
      conversations: conversations.map(normalizeConversationStreamFeedback),
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

  ensureDraftConversation() {
    const currentConversation = get().currentConversation;
    if (currentConversation) {
      return currentConversation.id;
    }

    const now = Date.now();
    const draftConversation: Conversation = {
      id: `draft_${now}`,
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
        m.id === msgId ? { ...m, status } : m,
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

function normalizeConversationStreamFeedback(
  conversation: Conversation,
): Conversation {
  return {
    ...conversation,
    messages: (conversation.messages ?? []).map(normalizeMessageStreamFeedback),
  };
}

function normalizeMessageStreamFeedback(message: Message): Message {
  if (
    message.role !== "assistant" ||
    message.streamFeedback ||
    message.currentStreamEvent ||
    !message.trace?.length
  ) {
    return message;
  }

  const streamFeedback = buildStreamFeedbackFromTrace(message.trace);
  if (!streamFeedback) {
    return message;
  }

  return {
    ...message,
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
    index === matchedIndex ? { ...event, ...nextEvent } : event,
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
