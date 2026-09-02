import Taro from "@tarojs/taro";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";
import { createBoundStore } from "./createBoundStore";
import { getUserProfile } from "../api/user";
import { ApiRequestError } from "../api/request";

interface UserState {
  token: string | null;
  userInfo: User | null;
  isLoggedIn: boolean;
  hydrate: () => void;
  login: (result: LoginResult) => void;
  logout: () => void;
  refreshProfile: () => Promise<void>;
}

export const useUserStore = createBoundStore<UserState>((set, get) => ({
  token: null,
  userInfo: null,
  isLoggedIn: false,

  /**
   * 恢复登录态
   * 从本地存储中恢复 token 和 userInfo
   */
  hydrate() {
    const token = storage.get<string>(STORAGE_KEYS.TOKEN);
    const userInfo = storage.get<User>(STORAGE_KEYS.USER_INFO);
    set({
      token,
      userInfo,
      isLoggedIn: !!token,
    });
  },

  /**
   * 登录
   * 将 token 和 userInfo 存储到本地存储中
   * @param result
   */
  login(result: LoginResult) {
    storage.set(STORAGE_KEYS.TOKEN, result.token);
    storage.set(STORAGE_KEYS.USER_INFO, result.user);
    set({
      token: result.token,
      userInfo: result.user,
      isLoggedIn: true,
    });
  },

  /**
   * 退出登录
   * 从本地存储中删除 token 和 userInfo
   */
  logout() {
    storage.remove(STORAGE_KEYS.TOKEN);
    storage.remove(STORAGE_KEYS.USER_INFO);
    set({
      token: null,
      userInfo: null,
      isLoggedIn: false,
    });
    Taro.redirectTo({ url: "/pages/login/index" });
  },

  async refreshProfile() {
    if (!get().isLoggedIn) return;
    try {
      const userInfo = await getUserProfile();
      storage.set(STORAGE_KEYS.USER_INFO, userInfo);
      set({ userInfo });
    } catch (error) {
      console.error("Refresh user profile failed:", error);
      // HTTP 业务错误已由请求层展示；网络类错误在这里补充可见反馈。
      if (!(error instanceof ApiRequestError)) {
        void Taro.showToast({ title: "会员状态刷新失败", icon: "none" });
      }
    }
  },
}));
