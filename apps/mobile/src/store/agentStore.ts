import { getAgents, type AgentSummary } from "../api/agents";
import {
  createAgentCache,
  isAgentList,
  readAgentCache,
} from "../services/agent-cache";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { createBoundStore } from "./createBoundStore";

interface AgentState {
  activeUserId: string | null;
  /** 选中的智能体 id；null = 用后端默认 agent（请求不带 agentId） */
  selectedAgentId: string | null;
  agents: AgentSummary[];
  /** 是否已成功拉到列表（失败不置位，保证后续挂载能重试） */
  loaded: boolean;
  loadError: string | null;
  hydrate: (userId: string | null) => void;
  resetForUser: (userId: string | null) => void;
  setSelectedAgent: (agentId: string | null) => void;
  loadAgents: () => Promise<void>;
  /** 仅在尚未加载成功时拉取（供各页面挂载时调用，天然幂等） */
  ensureAgents: () => Promise<void>;
}

/** 同一用户并发去重；切换账号后允许新用户立即发起独立请求。 */
let inFlight: {
  userId: string;
  requestId: symbol;
  promise: Promise<void>;
} | null = null;

export const useAgentStore = createBoundStore<AgentState>((set, get) => ({
  activeUserId: null,
  selectedAgentId: null,
  agents: [],
  loaded: false,
  loadError: null,

  /**
   * 恢复当前用户的智能体状态
   * @param userId 当前登录用户ID，未登录时为 null
   * @returns 无返回值
   * @description 只接受归属于当前用户且符合当前契约版本的缓存；旧缓存会被清除并等待网络刷新。
   */
  hydrate(userId) {
    if (!userId) {
      clearAgentStorage();
      set(emptyAgentState(null));
      return;
    }
    const stored = storage.get<string>(STORAGE_KEYS.SELECTED_AGENT_ID);
    const cached = readAgentCache<AgentSummary>(
      storage.get<unknown>(STORAGE_KEYS.AGENTS),
      userId,
    );
    if (!cached) {
      storage.remove(STORAGE_KEYS.AGENTS);
      storage.remove(STORAGE_KEYS.SELECTED_AGENT_ID);
    }
    set({
      activeUserId: userId,
      selectedAgentId: cached ? stored : null,
      agents: cached ?? [],
      loaded: Boolean(cached),
      loadError: null,
    });
  },

  /**
   * 切换智能体状态所属的登录用户
   * @param userId 新登录用户ID，退出登录时为 null
   * @returns 无返回值
   * @description 登录态变化时清除旧用户的列表、选择和模型偏好，防止资格投影跨账号复用。
   */
  resetForUser(userId) {
    clearAgentStorage();
    set(emptyAgentState(userId));
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
    const requestedUserId = get().activeUserId;
    if (!requestedUserId) {
      return;
    }
    if (inFlight?.userId === requestedUserId) {
      return inFlight.promise;
    }

    set({ loadError: null });
    const requestId = Symbol(requestedUserId);
    const promise = (async () => {
      try {
        const agents = await getAgents();
        if (!isAgentList(agents)) {
          throw new Error("智能体列表响应缺少访问资格字段");
        }
        if (get().activeUserId !== requestedUserId) {
          return;
        }
        set({ agents, loaded: true });
        storage.set(
          STORAGE_KEYS.AGENTS,
          createAgentCache(requestedUserId, agents),
        );

        // 粘性选择是持久化的，但选中的 agent 可能已被删除或禁用。不校验的话：
        // 界面上 findAgent 取不到、回落显示成默认助手的名字（看着像合法选择），
        // 发送时却仍带着这个死 id，后端照单全收把新会话永久绑上去，
        // 执行期查不到再静默回落——全链路零报错。
        const { selectedAgentId } = get();
        if (
          selectedAgentId &&
          !agents.some((a) => a.id === selectedAgentId && a.canUse)
        ) {
          get().setSelectedAgent(null);
        }
      } catch (error) {
        if (get().activeUserId === requestedUserId) {
          set({
            loadError:
              error instanceof Error ? error.message : "智能体列表加载失败",
          });
        }
      } finally {
        if (inFlight?.requestId === requestId) {
          inFlight = null;
        }
      }
    })();
    inFlight = { userId: requestedUserId, requestId, promise };

    return promise;
  },

  async ensureAgents() {
    if (get().loaded) {
      return;
    }
    await get().loadAgents();
  },
}));

/**
 * 创建指定登录用户的空智能体状态
 * @param userId 当前登录用户ID，未登录时为 null
 * @returns 返回不含列表、选择和加载错误的初始状态
 * @description 账号切换和退出登录共用同一份状态重置形状。
 */
function emptyAgentState(userId: string | null) {
  return {
    activeUserId: userId,
    selectedAgentId: null,
    agents: [],
    loaded: false,
    loadError: null,
  };
}

/**
 * 清除所有与当前用户关联的智能体本地状态
 * @returns 无返回值
 * @description 同时移除列表资格投影、粘性智能体选择和模型偏好，防止跨账号复用。
 */
function clearAgentStorage(): void {
  storage.remove(STORAGE_KEYS.AGENTS);
  storage.remove(STORAGE_KEYS.SELECTED_AGENT_ID);
  storage.remove(STORAGE_KEYS.AGENT_MODEL_SELECTIONS);
}
