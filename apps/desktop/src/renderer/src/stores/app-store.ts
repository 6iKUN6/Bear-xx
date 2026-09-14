import { create } from "zustand";
import { authStorage } from "@/api/auth-storage";
import { loginAccount, logoutAccount } from "@/api/endpoints";
import type { AuthUser } from "@/api/types";
import { useAgentStore } from "@/stores/agent-store";
import { useChatStore } from "@/stores/chat-store";
import { useModelStore } from "@/stores/model-store";

export type AppPage = "workbench" | "settings" | "login";

interface AppState {
  page: AppPage;
  /** 当前登录用户；null = 未登录 */
  user: AuthUser | null;
  setPage: (page: AppPage) => void;
  /** 启动时从 localStorage 恢复登录态 */
  hydrateAuth: () => void;
  /** 账号密码登录；失败抛 ApiError 由登录页展示 */
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** client 401 且刷新失败时调用：清本地态并回登录页 */
  handleUnauthorized: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  page: "workbench",
  user: null,

  setPage(page) {
    set({ page });
  },

  hydrateAuth() {
    const user = authStorage.getUser();
    if (user && authStorage.getToken()) {
      set({ user });
    }
  },

  async login(username, password) {
    const res = await loginAccount({ username, password });
    authStorage.set(res.token, res.refreshToken, res.user);
    set({ user: res.user, page: "workbench" });
  },

  async logout() {
    // 服务端把 token 加黑名单是 best-effort：失败（如已过期/断网）不阻断本地退出
    await logoutAccount().catch(() => undefined);
    authStorage.clear();
    useChatStore.getState().reset();
    useAgentStore.getState().reset();
    useModelStore.getState().reset();
    set({ user: null });
  },

  handleUnauthorized() {
    authStorage.clear();
    useChatStore.getState().reset();
    useAgentStore.getState().reset();
    useModelStore.getState().reset();
    set({ user: null, page: "login" });
  },
}));
