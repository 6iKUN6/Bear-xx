import { getAgents, type AgentSummary } from "../api/agents";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { createBoundStore } from "./createBoundStore";

interface AgentState {
  /** 选中的智能体 id；null = 用后端默认 agent（请求不带 agentId） */
  selectedAgentId: string | null;
  agents: AgentSummary[];
  /** 是否已成功拉到列表（失败不置位，保证后续挂载能重试） */
  loaded: boolean;
  hydrate: () => void;
  setSelectedAgent: (agentId: string | null) => void;
  loadAgents: () => Promise<void>;
  /** 仅在尚未加载成功时拉取（供各页面挂载时调用，天然幂等） */
  ensureAgents: () => Promise<void>;
}

/** 并发去重：多个组件同时挂载时只发一次请求 */
let inFlight: Promise<void> | null = null;

export const useAgentStore = createBoundStore<AgentState>((set, get) => ({
  selectedAgentId: null,
  agents: [],
  loaded: false,

  hydrate() {
    const stored = storage.get<string>(STORAGE_KEYS.SELECTED_AGENT_ID);
    if (stored) {
      set({ selectedAgentId: stored });
    }
    // 列表本地缓存：冷启动若首屏就是群聊，先用缓存渲染头像/@ 候选，
    // 再由网络请求刷新（否则空列表会导致头像回退默认熊、@ 无响应）。
    const cached = storage.get<AgentSummary[]>(STORAGE_KEYS.AGENTS);
    if (Array.isArray(cached) && cached.length > 0) {
      set({ agents: cached, loaded: true });
    }
  },

  setSelectedAgent(agentId) {
    if (agentId) {
      storage.set(STORAGE_KEYS.SELECTED_AGENT_ID, agentId);
    } else {
      storage.remove(STORAGE_KEYS.SELECTED_AGENT_ID);
    }
    set({ selectedAgentId: agentId });
  },

  async loadAgents() {
    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const agents = await getAgents();
        // 网关异常/被劫持时响应可能不是数组：宁可保留现有数据也不要清空
        if (!Array.isArray(agents)) {
          return;
        }
        const enabled = agents.filter((agent) => agent.enabled);
        set({ agents: enabled, loaded: true });
        storage.set(STORAGE_KEYS.AGENTS, enabled);
      } catch {
        // 失败**不置 loaded**：否则 `if (!loaded)` 的调用点全部失效，
        // 一次冷启动失败就会让本次会话再也拉不到列表（头像与 @ 永久不可用）。
      } finally {
        inFlight = null;
      }
    })();

    return inFlight;
  },

  async ensureAgents() {
    if (get().loaded) {
      return;
    }
    await get().loadAgents();
  },
}));
