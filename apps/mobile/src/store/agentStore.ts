import { getAgents, type AgentSummary } from "../api/agents";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { createBoundStore } from "./createBoundStore";

interface AgentState {
  /** 选中的智能体 id；null = 用后端默认 agent（请求不带 agentId） */
  selectedAgentId: string | null;
  agents: AgentSummary[];
  loaded: boolean;
  hydrate: () => void;
  setSelectedAgent: (agentId: string | null) => void;
  loadAgents: () => Promise<void>;
}

export const useAgentStore = createBoundStore<AgentState>((set) => ({
  selectedAgentId: null,
  agents: [],
  loaded: false,

  hydrate() {
    const stored = storage.get<string>(STORAGE_KEYS.SELECTED_AGENT_ID);
    if (stored) {
      set({ selectedAgentId: stored });
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
    try {
      const agents = await getAgents();
      set({ agents: agents.filter((agent) => agent.enabled), loaded: true });
    } catch {
      // 加载失败静默降级为空列表（选择器仅显示回退标题），不影响聊天主流程。
      set({ loaded: true });
    }
  },
}));
