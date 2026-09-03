import {
  defaultThemeId,
  isThemeId,
  getTheme,
  type ThemeColorScheme,
  type ThemeId,
} from "@litter-bear/theme";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";
import { createBoundStore } from "./createBoundStore";

interface ThemeState {
  themeId: ThemeId;
  /** 深浅模式；缺省跟随主题自身的默认模式 */
  mode: ThemeColorScheme;
  hydrate: () => void;
  setTheme: (themeId: ThemeId) => void;
  setMode: (mode: ThemeColorScheme) => void;
  toggleMode: () => void;
}

export const useThemeStore = createBoundStore<ThemeState>((set, get) => ({
  themeId: defaultThemeId,
  mode: "light",

  hydrate() {
    const storedThemeId = storage.get<unknown>(STORAGE_KEYS.THEME);
    const themeId = isThemeId(storedThemeId) ? storedThemeId : defaultThemeId;
    const storedMode = storage.get<unknown>(STORAGE_KEYS.THEME_MODE);
    set({
      themeId,
      mode: storedMode === "dark" ? "dark" : getTheme(themeId).colorScheme,
    });
  },

  setTheme(themeId) {
    storage.set(STORAGE_KEYS.THEME, themeId);
    // 切主题时跟随该主题的默认模式，用户可再用开关覆盖
    const mode = getTheme(themeId).colorScheme;
    storage.set(STORAGE_KEYS.THEME_MODE, mode);
    set({ themeId, mode });
  },

  setMode(mode) {
    storage.set(STORAGE_KEYS.THEME_MODE, mode);
    set({ mode });
  },

  toggleMode() {
    get().setMode(get().mode === "dark" ? "light" : "dark");
  },
}));
