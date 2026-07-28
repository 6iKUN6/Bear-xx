import { create } from "zustand";
import {
  createThemeCssVariables,
  defaultThemeId,
  getTheme,
  isThemeId,
  type ThemeId,
} from "@litter-bear/theme";

const STORAGE_KEY = "litter_bear_admin_theme";

/** 把选中主题的 --lb-* 变量写入 :root */
function applyTheme(themeId: ThemeId) {
  const variables = createThemeCssVariables(getTheme(themeId));
  const root = document.documentElement;
  for (const [name, value] of Object.entries(variables)) {
    root.style.setProperty(name, value);
  }
}

interface ThemeState {
  themeId: ThemeId;
  setTheme: (themeId: ThemeId) => void;
  hydrate: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  themeId: defaultThemeId,

  setTheme(themeId) {
    localStorage.setItem(STORAGE_KEY, themeId);
    applyTheme(themeId);
    set({ themeId });
  },

  hydrate() {
    const stored = localStorage.getItem(STORAGE_KEY);
    const themeId = isThemeId(stored) ? stored : defaultThemeId;
    applyTheme(themeId);
    set({ themeId });
  },
}));
