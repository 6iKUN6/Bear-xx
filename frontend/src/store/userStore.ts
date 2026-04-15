import Taro from "@tarojs/taro";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";
import { createBoundStore } from "./createBoundStore";

interface UserState {
  token: string | null;
  userInfo: User | null;
  isLoggedIn: boolean;
  hydrate: () => void;
  login: (result: LoginResult) => void;
  logout: () => void;
}

export const useUserStore = createBoundStore<UserState>((set) => ({
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
}));
