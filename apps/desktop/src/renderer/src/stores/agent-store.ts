import { create } from "zustand";
import { getAgents } from "@/api/endpoints";
import type { Agent } from "@/api/types";

/**
 * 智能体选择器状态
 * @description 桌面端 v1 保持轻量：登录后拉一次列表，选中项只活在内存
 * （不做跨用户本地缓存——移动端那套资格投影/缓存是为离线首页，桌面端每次
 * 启动都在线拉取即可）。selectedAgentId 为 null 时用后端默认智能体（请求不带 agentId）。
 */
interface AgentState {
  agents: Agent[];
  /** 选中的智能体 id；null = 后端默认 */
  selectedAgentId: string | null;
  loaded: boolean;
  loadError: string | null;
  loadAgents: () => Promise<void>;
  selectAgent: (agentId: string | null) => void;
  reset: () => void;
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  selectedAgentId: null,
  loaded: false,
  loadError: null,

  async loadAgents() {
    set({ loadError: null });
    try {
      const agents = await getAgents();
      set((state) => ({
        // 只展示可见的；按「可用优先 + 默认优先」排序
        agents: agents
          .filter((a) => a.visible)
          .sort((a, b) => Number(b.canUse) - Number(a.canUse) || Number(b.isDefault) - Number(a.isDefault)),
        loaded: true,
        // 选中项已不在列表（被下架/权限变化）时回落到默认
        selectedAgentId:
          state.selectedAgentId && agents.some((a) => a.id === state.selectedAgentId && a.canUse)
            ? state.selectedAgentId
            : null,
      }));
    } catch (error) {
      set({
        loadError: error instanceof Error ? error.message : "智能体列表加载失败",
      });
    }
  },

  selectAgent(agentId) {
    set({ selectedAgentId: agentId });
  },

  reset() {
    set({ agents: [], selectedAgentId: null, loaded: false, loadError: null });
  },
}));
