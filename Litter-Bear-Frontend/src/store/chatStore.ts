import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";
import * as chatApi from "../api/chat";
import { createBoundStore } from "./createBoundStore";

interface ChatState {
  conversations: Conversation[];
  currentConversation: Conversation | null;

  loadConversations: () => Promise<void>;
  createConversation: () => Promise<string>;
  deleteConversation: (id: string) => Promise<void>;
  setCurrentConversation: (id: string) => void;

  addMessage: (msg: Message) => void;
  updateMessageContent: (msgId: string, content: string) => void;
  updateMessageStatus: (msgId: string, status: MessageStatus) => void;

  persistConversations: () => void;
  hydrateConversations: () => void;
}

export const useChatStore = createBoundStore<ChatState>((set, get) => ({
  conversations: [],
  currentConversation: null,

  async loadConversations() {
    const conversations = await chatApi.getConversations();
    set({ conversations });
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
        state.currentConversation?.id === id
          ? null
          : state.currentConversation;
      return { conversations, currentConversation };
    });
    get().persistConversations();
  },

  setCurrentConversation(id: string) {
    const conv = get().conversations.find((c) => c.id === id) || null;
    set({ currentConversation: conv });
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
          state.currentConversation.messages.length === 0 &&
          msg.role === "user"
            ? msg.content.slice(0, 20)
            : state.currentConversation.title,
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageContent(msgId: string, content: string) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, content: m.content + content } : m
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c
      );

      return { currentConversation: updatedConv, conversations };
    });
  },

  updateMessageStatus(msgId: string, status: MessageStatus) {
    set((state) => {
      if (!state.currentConversation) return state;

      const messages = state.currentConversation.messages.map((m) =>
        m.id === msgId ? { ...m, status } : m
      );

      const updatedConv: Conversation = {
        ...state.currentConversation,
        messages,
        updatedAt: Date.now(),
      };

      const conversations = state.conversations.map((c) =>
        c.id === updatedConv.id ? updatedConv : c
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
    set({ conversations });
  },
}));
