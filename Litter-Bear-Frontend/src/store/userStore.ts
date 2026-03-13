import { create } from "zustand";
import Taro from "@tarojs/taro";
import * as storage from "../utils/storage";
import { STORAGE_KEYS } from "../utils/constants";

interface UserState {
  token: string | null;
  userInfo: User | null;
  isLoggedIn: boolean;
  hydrate: () => void;
  login: (result: LoginResult) => void;
  logout: () => void;
}

export const useUserStore = create<UserState>((set) => ({
  token: null,
  userInfo: null,
  isLoggedIn: false,

  hydrate() {
    const token = storage.get<string>(STORAGE_KEYS.TOKEN);
    const userInfo = storage.get<User>(STORAGE_KEYS.USER_INFO);
    set({
      token,
      userInfo,
      isLoggedIn: !!token,
    });
  },

  login(result: LoginResult) {
    storage.set(STORAGE_KEYS.TOKEN, result.token);
    storage.set(STORAGE_KEYS.USER_INFO, result.user);
    set({
      token: result.token,
      userInfo: result.user,
      isLoggedIn: true,
    });
  },

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
