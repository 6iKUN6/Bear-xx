import { create } from "zustand";
import { authStorage } from "@/api/auth-storage";
import { getAdminSession, login as loginApi } from "@/api/endpoints";
import type { AuthUser } from "@/api/types";

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hydrate: () => void;
  refreshSession: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: authStorage.getUser(),
  isAuthenticated: Boolean(authStorage.getToken()),

  async login(username, password) {
    const res = await loginApi(username, password);
    authStorage.set(res.token, res.refreshToken, res.user);
    set({ user: res.user, isAuthenticated: true });
  },

  logout() {
    authStorage.clear();
    set({ user: null, isAuthenticated: false });
  },

  hydrate() {
    set({
      user: authStorage.getUser(),
      isAuthenticated: Boolean(authStorage.getToken()),
    });
  },

  async refreshSession() {
    const user = await getAdminSession();
    authStorage.updateUser(user);
    set({ user, isAuthenticated: true });
  },
}));
